import { config as loadDotenv } from 'dotenv';

// Load `.env` exactly once, as early as possible. Imported for its side effects
// by every module that reads `process.env` at import time (config, logger).
loadDotenv({ quiet: true });
