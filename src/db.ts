import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export async function getOrCreateUser(phone: string) {
  return prisma.user.upsert({
    where: { phone },
    update: {},
    create: { phone },
  });
}
