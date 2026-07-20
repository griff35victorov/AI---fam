export async function createPrismaClient({
  PrismaClient,
  importClient = () => import("@prisma/client"),
} = {}) {
  const Client = PrismaClient ?? (await importClient()).PrismaClient;

  if (!Client) {
    throw new Error("PrismaClient export is required");
  }

  return new Client();
}
