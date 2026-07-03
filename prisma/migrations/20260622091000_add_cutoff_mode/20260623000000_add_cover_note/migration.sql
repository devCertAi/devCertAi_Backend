-- Add coverNote to Application (optional, for recruiter to read)
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "coverNote" TEXT;
