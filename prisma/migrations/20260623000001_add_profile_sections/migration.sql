-- Add extraCurricular and accomplishments to ProfileDetail
ALTER TABLE "ProfileDetail" ADD COLUMN IF NOT EXISTS "extraCurricular" TEXT;
ALTER TABLE "ProfileDetail" ADD COLUMN IF NOT EXISTS "accomplishments" TEXT;

-- ProfileTraining
CREATE TABLE IF NOT EXISTS "ProfileTraining" (
  "id"           TEXT NOT NULL,
  "profileId"    TEXT NOT NULL,
  "program"      TEXT NOT NULL,
  "organization" TEXT,
  "location"     TEXT,
  "isOnline"     BOOLEAN NOT NULL DEFAULT false,
  "startDate"    TIMESTAMP(3),
  "endDate"      TIMESTAMP(3),
  "isOngoing"    BOOLEAN NOT NULL DEFAULT false,
  "description"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfileTraining_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "ProfileTraining" ADD CONSTRAINT "ProfileTraining_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "ProfileDetail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "ProfileTraining_profileId_idx" ON "ProfileTraining"("profileId");

-- ProfileProject
CREATE TABLE IF NOT EXISTS "ProfileProject" (
  "id"          TEXT NOT NULL,
  "profileId"   TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "startDate"   TIMESTAMP(3),
  "endDate"     TIMESTAMP(3),
  "isOngoing"   BOOLEAN NOT NULL DEFAULT false,
  "projectUrl"  TEXT,
  "description" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfileProject_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "ProfileProject" ADD CONSTRAINT "ProfileProject_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "ProfileDetail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "ProfileProject_profileId_idx" ON "ProfileProject"("profileId");

-- ProfilePortfolio
CREATE TABLE IF NOT EXISTS "ProfilePortfolio" (
  "id"        TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "title"     TEXT NOT NULL,
  "url"       TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfilePortfolio_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "ProfilePortfolio" ADD CONSTRAINT "ProfilePortfolio_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "ProfileDetail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "ProfilePortfolio_profileId_idx" ON "ProfilePortfolio"("profileId");