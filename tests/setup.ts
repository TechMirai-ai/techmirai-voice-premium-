import { config as loadDotenv } from 'dotenv';

// Reads TEST_DATABASE_URL (and anything else) from .env if the developer has one.
loadDotenv({ quiet: true });

process.env.NODE_ENV = 'test';
