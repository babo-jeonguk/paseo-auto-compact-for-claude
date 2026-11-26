import { Stopped } from "../../server/deadline";

// What a stopped component hands its error owner besides the stop itself. A
// component passes its own `Stopped` on like any outcome, and the reporter
// keeps it quiet (server/report.ts), so a test of a stop checks the rest.
export const defects = (errors: readonly unknown[]) => errors.filter(error => !(error instanceof Stopped)).map(String);
