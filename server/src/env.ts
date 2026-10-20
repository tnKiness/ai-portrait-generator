import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgres://portrait:portrait@localhost:5432/portrait'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  STORAGE_DIR: z.string().default('./var/storage'),
  IMAGE_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_IMAGE_MODEL: z.string().default('gpt-image-1'),
  MAX_ACTIVE_JOBS_PER_USER: z.coerce.number().int().positive().default(2),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  JOB_LEASE_SECONDS: z.coerce.number().int().positive().default(120),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = schema.parse(source);
  if (env.IMAGE_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    throw new Error('IMAGE_PROVIDER=openai requires OPENAI_API_KEY');
  }
  return env;
}
