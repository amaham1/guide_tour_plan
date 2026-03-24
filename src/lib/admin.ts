import { appEnv } from "@/lib/env";
import { InternalAdminDisabledError } from "@/lib/errors";

export function assertInternalAdminEnabled() {
  if (!appEnv.enableInternalAdmin) {
    throw new InternalAdminDisabledError();
  }
}
