import { PrismaClient } from "@prisma/client";
import { syncSourceCatalog } from "../src/lib/source-catalog";

const prisma = new PrismaClient();

async function main() {
  await syncSourceCatalog(prisma);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
