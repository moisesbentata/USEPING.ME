-- AlterTable
ALTER TABLE "Reminder" ADD COLUMN "recurrenceRule" TEXT;
ALTER TABLE "Reminder" ADD COLUMN "recurrenceDtstart" TIMESTAMP(3);
ALTER TABLE "Reminder" ADD COLUMN "groupId" TEXT;
