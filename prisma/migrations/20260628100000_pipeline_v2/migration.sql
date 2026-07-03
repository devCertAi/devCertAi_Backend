-- Migration: 20260628100000_pipeline_v2
-- Adds recruiter pipeline configuration v2:
--   1. JobPosting: separate assignment fields (user-visible vs eval), examDomain, examPhases, manualMode
--   2. Application: phase2ExamAttemptId for two-phase pipeline exam
--   3. Recruiter credits for hiring (1 credit = 1 hiring cycle per posting)

-- Assignment split: user-visible brief + private eval criteria
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "assignmentBrief"    TEXT;          -- what student sees
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "assignmentEvalCriteria" TEXT;      -- private: used to score project
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "assignmentDeadlineDate" TIMESTAMP(3); -- absolute date (must be > createdAt)

-- Exam config: domain selection, which phases
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "examDomain"    TEXT    DEFAULT 'Full Stack';
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "examPhase1"    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "examPhase2"    BOOLEAN NOT NULL DEFAULT false;

-- Manual pipeline mode
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "manualMode"    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "hiringCreditUsed" BOOLEAN NOT NULL DEFAULT false;

-- Application: phase2 exam attempt
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "phase2ExamAttemptId" TEXT UNIQUE;

-- Recruiter credit: 1 free hiring cycle (used once per recruiter lifetime, resets annually)
ALTER TABLE "UserCredits" ADD COLUMN IF NOT EXISTS "freeHiringCycleUsed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserCredits" ADD COLUMN IF NOT EXISTS "hiringCredits"        INT     NOT NULL DEFAULT 1;  -- 1 free cycle
ALTER TABLE "UserCredits" ADD COLUMN IF NOT EXISTS "hiringCreditsUsed"    INT     NOT NULL DEFAULT 0;

-- Indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS "JobPosting_manualMode_idx" ON "JobPosting"("manualMode");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Application_phase2ExamAttemptId_idx" ON "Application"("phase2ExamAttemptId");
