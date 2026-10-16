import { defineService } from "../../../../core/src/index";
import type { SessionService } from "./types";

const defined = defineService<SessionService>({ name: "session", methods: { list: {}, create: {}, get: {}, append: {}, history: {}, conversation: {}, fork: {}, getCommit: {} } });
if (!defined.ok) throw new Error("Invalid session service definition");
export const session = defined.value;
