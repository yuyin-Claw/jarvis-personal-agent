export interface GoalLike {
  id: string;
  content: string;
  updatedAt: string;
}
export interface GoalFollowup extends GoalLike {
  daysInactive: number;
}

/** 长期目标规则：超过 N 天未复核才提醒；不调用 LLM，通知冷却/静默时段仍由 ProactiveEngine 裁决。 */
export function findStaleGoals(goals: GoalLike[], now = new Date(), olderThanDays = 7): GoalFollowup[] {
  return goals.flatMap((goal) => {
    const updated = Date.parse(goal.updatedAt);
    if (!Number.isFinite(updated)) return [];
    const daysInactive = Math.floor((now.getTime() - updated) / 86_400_000);
    return daysInactive >= olderThanDays ? [{ ...goal, daysInactive }] : [];
  }).sort((a, b) => b.daysInactive - a.daysInactive);
}
