-- AlterTable
ALTER TABLE "JobPosting" ADD COLUMN "cutoffMode" TEXT NOT NULL DEFAULT 'count',
ADD COLUMN "cutoffPercentage" INTEGER;
