/**
 * Minimal Google Drive v3 client for the developer audio archive (VP-12).
 *
 * Uploads are *resumable* (init request, then one PUT of the bytes) so a long call's recording does
 * not hit the 5 MB limit of simple/multipart uploads. Scope in use is `drive.file`: the app only
 * ever sees files and folders it created itself, which is why the consent step creates the folder.
 */
import { z } from 'zod';

import type { AccessTokenProvider } from './auth.js';
import { GoogleApiError, googleFetch } from './http.js';

export { GoogleApiError };

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export interface UploadRequest {
  folderId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface UploadedFile {
  id: string;
  /** The owner-only "view" link — permanent, unlike Vapi's expiring recording URL. */
  link: string;
}

export interface DriveFileInfo {
  id: string;
  trashed: boolean;
  sizeBytes: number;
  link: string;
}

export interface DriveClient {
  createFolder(name: string): Promise<string>;
  uploadFile(request: UploadRequest): Promise<UploadedFile>;
  getFile(fileId: string): Promise<DriveFileInfo>;
  deleteFile(fileId: string): Promise<void>;
}

const uploadedSchema = z.object({ id: z.string().min(1), webViewLink: z.string().min(1) });
const folderSchema = z.object({ id: z.string().min(1) });
const infoSchema = z.object({
  id: z.string().min(1),
  trashed: z.boolean().optional(),
  size: z.string().optional(),
  webViewLink: z.string().optional(),
});

async function readJson<T extends z.ZodType>(response: Response, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new GoogleApiError(
      'Google Drive response was not in the expected shape.',
      response.status,
    );
  }
  return parsed.data;
}

export function createDriveClient(
  auth: AccessTokenProvider,
  fetchFn: typeof fetch = fetch,
): DriveClient {
  const json = { 'content-type': 'application/json; charset=UTF-8' };

  return {
    async createFolder(name) {
      const response = await googleFetch(fetchFn, auth, `${DRIVE_FILES_URL}?fields=id`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name, mimeType: FOLDER_MIME_TYPE }),
      });
      return (await readJson(response, folderSchema)).id;
    },

    async uploadFile({ folderId, name, mimeType, bytes }) {
      const init = await googleFetch(
        fetchFn,
        auth,
        `${DRIVE_UPLOAD_URL}?uploadType=resumable&fields=id,webViewLink`,
        {
          method: 'POST',
          headers: { ...json, 'x-upload-content-type': mimeType },
          body: JSON.stringify({ name, parents: [folderId] }),
        },
      );
      const sessionUrl = init.headers.get('location');
      if (!sessionUrl) {
        throw new GoogleApiError('Google Drive did not return an upload session.', init.status);
      }

      const uploaded = await googleFetch(fetchFn, auth, sessionUrl, {
        method: 'PUT',
        headers: { 'content-type': mimeType },
        body: bytes,
      });
      const file = await readJson(uploaded, uploadedSchema);
      return { id: file.id, link: file.webViewLink };
    },

    async getFile(fileId) {
      const fields = new URLSearchParams({ fields: 'id,trashed,size,webViewLink' });
      const response = await googleFetch(
        fetchFn,
        auth,
        `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?${fields.toString()}`,
      );
      const info = await readJson(response, infoSchema);
      return {
        id: info.id,
        trashed: info.trashed ?? false,
        sizeBytes: Number(info.size ?? 0),
        link: info.webViewLink ?? '',
      };
    },

    async deleteFile(fileId) {
      await googleFetch(fetchFn, auth, `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`, {
        method: 'DELETE',
      });
    },
  };
}
