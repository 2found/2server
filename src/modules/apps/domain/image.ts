import { z } from "zod";
export const imageReference = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:\-]*(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]*|@sha256:[a-f0-9]{64})$/);
