export interface HistorySearchTask {
  readonly title: string;
  readonly details: string;
  readonly workflow: {
    readonly task: {
      readonly status: string;
    };
  };
}

export function filterTasksForHistory<T extends HistorySearchTask>(
  tasks: readonly T[],
  query: string,
  selectedStatus: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase();

  return tasks.filter((task) => {
    if (selectedStatus !== 'all' && task.workflow.task.status !== selectedStatus) {
      return false;
    }

    if (!needle) return true;

    return [task.title, task.details, task.workflow.task.status].some((value) =>
      value.toLocaleLowerCase().includes(needle),
    );
  });
}
