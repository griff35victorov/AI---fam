export async function createPrismaClient({
  PrismaClient,
  importClient = () => import("@prisma/client"),
} = {}) {
  let Client = PrismaClient;

  if (!Client) {
    try {
      Client = (await importClient()).PrismaClient;
    } catch (error) {
      if (error?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "@prisma/client is not installed or generated. Install Prisma dependencies and run db:generate before starting the PostgreSQL runtime.",
          { cause: error },
        );
      }

      throw error;
    }
  }

  if (!Client) {
    throw new Error("PrismaClient export is required");
  }

  return new Client();
}
