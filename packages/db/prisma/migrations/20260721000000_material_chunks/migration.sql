-- AlterTable
ALTER TABLE "Material" ADD COLUMN "scope" "WorkspaceKind" NOT NULL DEFAULT 'teacher_private';
ALTER TABLE "Material" ADD COLUMN "sensitivity" "Sensitivity" NOT NULL DEFAULT 'normal';
ALTER TABLE "Material" ADD COLUMN "description" TEXT;
ALTER TABLE "Material" ADD COLUMN "sourceMessageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Material" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "MaterialChunk" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "scope" "WorkspaceKind" NOT NULL DEFAULT 'teacher_private',
    "sensitivity" "Sensitivity" NOT NULL DEFAULT 'normal',
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "tokenEstimate" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaterialChunk_workspaceId_ownerUserId_idx" ON "MaterialChunk"("workspaceId", "ownerUserId");

-- CreateIndex
CREATE INDEX "MaterialChunk_materialId_chunkIndex_idx" ON "MaterialChunk"("materialId", "chunkIndex");

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialChunk" ADD CONSTRAINT "MaterialChunk_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialChunk" ADD CONSTRAINT "MaterialChunk_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialChunk" ADD CONSTRAINT "MaterialChunk_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
