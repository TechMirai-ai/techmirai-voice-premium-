import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Clinic data and personal data must never reach stdout directly:
      // everything goes through src/lib/logger.ts, which redacts.
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // The CLIs and the logger are the only places allowed to write to stdout.
    files: ['src/config/checkCli.ts', 'src/db/migrate.ts', 'src/lib/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Test fixtures edit parsed YAML documents, whose shape is only known at
    // runtime. src/ stays fully type-safe; these relaxations are test-only.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['eslint.config.js', 'vitest.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
