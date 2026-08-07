/**
 * Holds the id of the browser action currently in flight, if any, so
 * evidence collectors (console/page-error/network) can tag the events
 * they observe with the same actionId at capture time — never invented
 * afterwards by correlating timestamps.
 *
 * Exactly one action can be "current" at a time, matching the engine's
 * one-action-per-observation-cycle rule (AGENT.MD, "Execute one browser
 * action per observation cycle").
 */
export class ActionContext {
  private currentActionId: string | undefined;

  get(): string | undefined {
    return this.currentActionId;
  }

  set(actionId: string): void {
    this.currentActionId = actionId;
  }

  clear(): void {
    this.currentActionId = undefined;
  }
}
