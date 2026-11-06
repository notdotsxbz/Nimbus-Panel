import { Public } from "../../common/auth.decorators";
import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "nimbus:isPublic";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
