import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "nimbus:isPublic";

/** Marks an endpoint as publicly reachable (skips the JWT auth guard). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
