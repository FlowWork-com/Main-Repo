import { describe, expect, it } from 'vitest';
import { filterTasksForHistory, type HistorySearchTask } from './taskHistory';

const tasks: HistorySearchTask[] = [
  {
    title: 'Prepare Q3 spreadsheet',
    details: 'Summarize revenue by region',
    workflow: { task: { status: 'Planning' } },
  },
  {
    title: 'Draft monthly report',
    details: 'Prepare a review copy for Finance',
    workflow: { task: { status: 'Completed' } },
  },
  {
    title: 'Check vendor records',
    details: 'Review new supplier entries',
    workflow: { task: { status: 'Failed' } },
  },
];

describe('filterTasksForHistory', () => {
  it('returns all tasks when no search or status filter is selected', () => {
    expect(filterTasksForHistory(tasks, '', 'all')).toEqual(tasks);
  });

  it('searches titles, full request details, and statuses case-insensitively', () => {
    expect(filterTasksForHistory(tasks, 'q3', 'all')).toEqual([tasks[0]]);
    expect(filterTasksForHistory(tasks, 'FINANCE', 'all')).toEqual([tasks[1]]);
    expect(filterTasksForHistory(tasks, 'failed', 'all')).toEqual([tasks[2]]);
  });

  it('combines search and status filters', () => {
    expect(filterTasksForHistory(tasks, 'report', 'Completed')).toEqual([tasks[1]]);
    expect(filterTasksForHistory(tasks, 'report', 'Planning')).toEqual([]);
  });

  it('trims whitespace around the query', () => {
    expect(filterTasksForHistory(tasks, '  vendor  ', 'all')).toEqual([tasks[2]]);
  });
});
