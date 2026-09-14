export type UpdateChoice = 'apply' | 'skip' | 'cancel';

export interface UpdatePrompt {
  /** Present an update prompt to the user.
   *  Returns the user's choice, or null if the prompt was dismissed (timeout / superseded). */
  ask(spec: { latestVersion: string }): Promise<UpdateChoice | null>;
}
