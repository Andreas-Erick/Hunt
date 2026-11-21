"use client";

import { useLiveQuery } from "dexie-react-hooks";
import type { TimeLog } from "@/lib/db";
import { reads } from "@/lib/reads";
import { rollingWeekKeys } from "@/lib/questProgress";

/**
 * Time logs of the rolling quest week ending on `todayKey`. Only that week is
 * read (dateKey is indexed), never the whole history; undefined while loading.
 */
export function useQuestWeekLogs(todayKey: string): TimeLog[] | undefined {
  return useLiveQuery(
    () => reads.logsOnDays(rollingWeekKeys(todayKey)),
    [todayKey]
  );
}
