import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection } from "mongoose";

type DbLike = NonNullable<Connection["db"]>;

interface Migration {
  id: string;
  description: string;
  run: (db: DbLike) => Promise<unknown>;
}

/**
 * Versioned, backward-compatible database migrations. Applied migrations are
 * recorded in the `migrations` collection — each runs exactly once. Safe to
 * boot the API against any database state (fresh or upgraded).
 */
@Injectable()
export class MigrationsService implements OnModuleInit {
  private readonly logger = new Logger(MigrationsService.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private migrations(): Migration[] {
    const db = this.connection.db as DbLike;
    return [
      {
        id: "001-services-objectid-normalization",
        description: "Convert services.nodeId/ownerId from BSON String to ObjectId (legacy builds stored strings)",
        run: async () => {
          // $toObjectId fails on values that are already ObjectIds, hence the
          // $type guard in the filter. Documents without either field are skipped.
          await db.command({
            update: "services",
            updates: [
              {
                q: { $or: [{ nodeId: { $type: "string" } }, { ownerId: { $type: "string" } }] },
                u: [
                  {
                    $set: {
                      nodeId: {
                        $cond: [
                          { $eq: [{ $type: "$nodeId" }, "string"] },
                          { $toObjectId: "$nodeId" },
                          "$nodeId",
                        ],
                      },
                      ownerId: {
                        $cond: [
                          { $eq: [{ $type: "$ownerId" }, "string"] },
                          { $toObjectId: "$ownerId" },
                          "$ownerId",
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          });
        },
      },
      {
        id: "002-domains-objectid-normalization",
        description: "Convert domains.ownerId/serviceId from BSON String to ObjectId",
        run: async () => {
          await db.command({
            update: "domains",
            updates: [
              {
                q: { $or: [{ ownerId: { $type: "string" } }, { serviceId: { $type: "string" } }] },
                u: [
                  {
                    $set: {
                      ownerId: {
                        $cond: [{ $eq: [{ $type: "$ownerId" }, "string"] }, { $toObjectId: "$ownerId" }, "$ownerId"],
                      },
                      serviceId: {
                        $cond: [{ $eq: [{ $type: "$serviceId" }, "string"] }, { $toObjectId: "$serviceId" }, "$serviceId"],
                      },
                    },
                  },
                ],
              },
            ],
          });
        },
      },
    ];
  }

  async onModuleInit(): Promise<void> {
    const db = this.connection.db!;
    const applied = db.collection("migrations");
    for (const migration of this.migrations()) {
      const done = await applied.findOne({ id: migration.id });
      if (done) continue;
      try {
        await migration.run(db);
        await applied.insertOne({ id: migration.id, description: migration.description, appliedAt: new Date() });
        this.logger.log(`migration ${migration.id} applied`);
      } catch (err) {
        // Boot continues — the panel works without migrations; the failure is
        // logged loudly and the migration can be re-run on next boot.
        this.logger.error(`migration ${migration.id} FAILED: ${(err as Error).message}`);
      }
    }
  }
}
