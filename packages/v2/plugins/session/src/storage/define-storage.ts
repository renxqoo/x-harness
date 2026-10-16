import { defineService } from "../../../../core/src/index";
import type { SessionStorage } from "./types";

const defined = defineService<SessionStorage>({ name: "session-storage", methods: { initialize: {}, read: {}, create: {}, commit: {}, history: {}, conversation: {}, fork: {}, getCommit: {} } });
if (!defined.ok) throw new Error("Invalid session storage definition");
export const sessionStorage = defined.value;
