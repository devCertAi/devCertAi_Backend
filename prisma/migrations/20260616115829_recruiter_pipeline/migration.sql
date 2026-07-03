/*
  Warnings:

  - A unique constraint covering the columns `[applicationId]` on the table `ExamAttempt` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "ExamAttempt" ADD COLUMN     "applicationId" TEXT,
ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notifyOnMatch" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSkill" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "level" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobPosting" (
    "id" TEXT NOT NULL,
    "recruiterId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "minExperience" INTEGER NOT NULL DEFAULT 0,
    "openings" INTEGER NOT NULL DEFAULT 1,
    "ruleScoreThreshold" INTEGER NOT NULL DEFAULT 60,
    "aiMatchThreshold" INTEGER NOT NULL DEFAULT 50,
    "assignmentText" TEXT,
    "assignmentDeadlineDays" INTEGER,
    "examEnabled" BOOLEAN NOT NULL DEFAULT true,
    "examDurationMin" INTEGER NOT NULL DEFAULT 30,
    "examWindowHours" INTEGER NOT NULL DEFAULT 48,
    "scoringWeights" JSONB,
    "matchNotificationCap" INTEGER NOT NULL DEFAULT 200,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "applyLinkSlug" TEXT NOT NULL,
    "questionBank" JSONB,
    "rankingSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobPostingSkill" (
    "id" TEXT NOT NULL,
    "jobPostingId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "JobPostingSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "jobPostingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resumeUrl" TEXT,
    "resumeText" TEXT,
    "ruleScore" INTEGER,
    "aiMatchScore" INTEGER,
    "aiReasoning" TEXT,
    "missingSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stage" TEXT NOT NULL DEFAULT 'applied',
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "rejectionReason" TEXT,
    "selectionNarrative" TEXT,
    "assignmentSubmissionId" TEXT,
    "assignmentDeadlineAt" TIMESTAMP(3),
    "examWindowExpiresAt" TIMESTAMP(3),
    "projectId" TEXT,
    "examAttemptId" TEXT,
    "projectScore" DOUBLE PRECISION,
    "examScore" DOUBLE PRECISION,
    "finalScore" DOUBLE PRECISION,
    "rank" INTEGER,
    "assignmentRemindersSent" INTEGER NOT NULL DEFAULT 0,
    "examRemindersSent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParsedResume" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "parsedSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "experienceYears" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParsedResume_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Skill_name_key" ON "Skill"("name");

-- CreateIndex
CREATE INDEX "Skill_name_idx" ON "Skill"("name");

-- CreateIndex
CREATE INDEX "UserSkill_skillId_idx" ON "UserSkill"("skillId");

-- CreateIndex
CREATE INDEX "UserSkill_userId_idx" ON "UserSkill"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSkill_userId_skillId_key" ON "UserSkill"("userId", "skillId");

-- CreateIndex
CREATE UNIQUE INDEX "JobPosting_applyLinkSlug_key" ON "JobPosting"("applyLinkSlug");

-- CreateIndex
CREATE INDEX "JobPosting_recruiterId_idx" ON "JobPosting"("recruiterId");

-- CreateIndex
CREATE INDEX "JobPosting_status_idx" ON "JobPosting"("status");

-- CreateIndex
CREATE INDEX "JobPostingSkill_skillId_idx" ON "JobPostingSkill"("skillId");

-- CreateIndex
CREATE INDEX "JobPostingSkill_jobPostingId_idx" ON "JobPostingSkill"("jobPostingId");

-- CreateIndex
CREATE UNIQUE INDEX "JobPostingSkill_jobPostingId_skillId_key" ON "JobPostingSkill"("jobPostingId", "skillId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_assignmentSubmissionId_key" ON "Application"("assignmentSubmissionId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_examAttemptId_key" ON "Application"("examAttemptId");

-- CreateIndex
CREATE INDEX "Application_jobPostingId_idx" ON "Application"("jobPostingId");

-- CreateIndex
CREATE INDEX "Application_userId_idx" ON "Application"("userId");

-- CreateIndex
CREATE INDEX "Application_stage_idx" ON "Application"("stage");

-- CreateIndex
CREATE INDEX "Application_status_idx" ON "Application"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Application_jobPostingId_userId_key" ON "Application"("jobPostingId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ParsedResume_userId_key" ON "ParsedResume"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttempt_applicationId_key" ON "ExamAttempt"("applicationId");

-- CreateIndex
CREATE INDEX "ExamAttempt_applicationId_idx" ON "ExamAttempt"("applicationId");

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSkill" ADD CONSTRAINT "UserSkill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSkill" ADD CONSTRAINT "UserSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobPosting" ADD CONSTRAINT "JobPosting_recruiterId_fkey" FOREIGN KEY ("recruiterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobPostingSkill" ADD CONSTRAINT "JobPostingSkill_jobPostingId_fkey" FOREIGN KEY ("jobPostingId") REFERENCES "JobPosting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobPostingSkill" ADD CONSTRAINT "JobPostingSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_jobPostingId_fkey" FOREIGN KEY ("jobPostingId") REFERENCES "JobPosting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParsedResume" ADD CONSTRAINT "ParsedResume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
