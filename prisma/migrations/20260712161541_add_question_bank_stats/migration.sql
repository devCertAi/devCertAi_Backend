-- AlterTable
ALTER TABLE "Certificate" ADD COLUMN     "difficulty" TEXT;

-- AlterTable
ALTER TABLE "ExamAttempt" ADD COLUMN     "difficulty" TEXT;

-- CreateTable
CREATE TABLE "QuestionBankStats" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "phase" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionBankStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuestionBankStats_domain_phase_idx" ON "QuestionBankStats"("domain", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionBankStats_domain_category_phase_level_key" ON "QuestionBankStats"("domain", "category", "phase", "level");
