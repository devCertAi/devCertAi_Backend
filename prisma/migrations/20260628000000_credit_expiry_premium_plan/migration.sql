-- Migration: 20260628000000_credit_expiry_premium_plan
-- Adds:
--   1. UserCredits.signupBonusGranted (idempotent signup bonus tracking)
--   2. User.premiumPlan (which plan they purchased)
--   3. CreditTransaction.expiresAt (when purchased credits expire)
--   4. Index improvements

-- Add signupBonusGranted to UserCredits
ALTER TABLE "UserCredits" ADD COLUMN IF NOT EXISTS "signupBonusGranted" BOOLEAN NOT NULL DEFAULT false;

-- Add premiumPlan to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "premiumPlan" TEXT;

-- Add expiresAt to CreditTransaction
ALTER TABLE "CreditTransaction" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

-- Add performance indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS "UserCredits_cycleResetAt_idx" ON "UserCredits"("cycleResetAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CreditTransaction_userId_createdAt_idx" ON "CreditTransaction"("userId", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Application_finalScore_idx" ON "Application"("finalScore");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_role_idx" ON "User"("role");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ExamAttempt_status_idx" ON "ExamAttempt"("status");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "OtpStore_expiresAt_idx" ON "OtpStore"("expiresAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Payment_userId_idx" ON "Payment"("userId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Payment_status_idx" ON "Payment"("status");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "JobPosting_applyLinkSlug_idx" ON "JobPosting"("applyLinkSlug");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "RecruiterNotification_recruiterId_isRead_idx" ON "RecruiterNotification"("recruiterId", "isRead");
