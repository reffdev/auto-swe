import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ForemanDashboard } from './ForemanDashboard'
import type { ForemanPollResponse } from './api'

// Mock the api module
const mockForemanPoll = jest.fn<Promise<ForemanPollResponse>, []>()
const mockSyncForemanYaml = jest.fn()
const mockQueueAllForemanTasks = jest.fn()
const mockQueueForemanTask = jest.fn()
const mockCancelForemanTask = jest.fn()
const mockCompleteForemanTask = jest.fn()

jest.mock('./api', () => ({
  foremanPoll: () => mockForemanPoll(),
  syncForemanYaml: () => mockSyncForemanYaml(),
  queueAllForemanTasks: () => mockQueueAllForemanTasks(),
  queueForemanTask: (id: string) => mockQueueForemanTask(id),
  cancelForemanTask: (id: string) => mockCancelForemanTask(id),
  completeForemanTask: (id: string) => mockCompleteForemanTask(id),
}))

// Mock useNavigate
const mockNavigate = jest.fn()
jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

const basePollResponse: ForemanPollResponse = {
  config: {
    id: 'default',
    enabled: 1,
    project_id: 'proj-1',
    tasks_dir: '/path/to/tasks',
    priority_mode: 'parallel',
    tick_interval_ms: 30000,
    created_at: '2026-01-01T00:00:00Z',
  },
  tasks: [],
  activeIds: [],
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <ForemanDashboard />
    </MemoryRouter>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockForemanPoll.mockResolvedValue(basePollResponse)
})

describe('ForemanDashboard', () => {
  it('shows loading state', () => {
    mockForemanPoll.mockReturnValue(new Promise(() => {})) // never resolves
    renderDashboard()
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('shows config prompt when no config', async () => {
    mockForemanPoll.mockResolvedValue({ config: null, tasks: [], activeIds: [] })
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText('Foreman is not configured yet.')).toBeInTheDocument()
    })
  })

  it('renders task list', async () => {
    mockForemanPoll.mockResolvedValue({
      ...basePollResponse,
      tasks: [{
        id: 't1', yaml_id: '001', project_id: 'proj-1', title: 'Currency Manager',
        description: '', priority: 1, type: 'code', model: 'auto',
        target_files: null, depends_on: null, acceptance_criteria: null,
        status: 'backlog', machine_id: null, resolved_model: null,
        retry_count: 0, max_retries: 3, error_message: null,
        git_branch: null, git_worktree: null, git_pr_url: null, git_pr_number: null,
        next_retry_at: null, started_at: null, completed_at: null,
        duration_ms: null, prompt_tokens: null, completion_tokens: null,
        created_at: '2026-01-01T00:00:00Z', yaml_synced_at: null,
      }],
    })
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText('Currency Manager')).toBeInTheDocument()
      expect(screen.getByText('#001')).toBeInTheDocument()
      expect(screen.getByText('P1')).toBeInTheDocument()
    })
  })

  it('shows empty state when no tasks', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText(/No tasks/)).toBeInTheDocument()
    })
  })

  it('calls sync API when Sync YAML clicked', async () => {
    mockSyncForemanYaml.mockResolvedValue({ imported: 3, updated: 1, errors: [] })
    renderDashboard()
    await waitFor(() => screen.getByText('Sync YAML'))
    fireEvent.click(screen.getByText('Sync YAML'))
    await waitFor(() => {
      expect(mockSyncForemanYaml).toHaveBeenCalled()
      expect(screen.getByText(/Imported: 3/)).toBeInTheDocument()
    })
  })

  it('calls queue all API', async () => {
    mockQueueAllForemanTasks.mockResolvedValue({ queued: 5 })
    renderDashboard()
    await waitFor(() => screen.getByText('Queue All'))
    fireEvent.click(screen.getByText('Queue All'))
    await waitFor(() => {
      expect(mockQueueAllForemanTasks).toHaveBeenCalled()
    })
  })

  it('filters tasks by status', async () => {
    mockForemanPoll.mockResolvedValue({
      ...basePollResponse,
      tasks: [
        { ...basePollResponse.tasks[0]!, id: 't1', title: 'Backlog Task', status: 'backlog', yaml_id: null, project_id: 'p', description: '', priority: 3, type: 'code', model: 'auto', target_files: null, depends_on: null, acceptance_criteria: null, machine_id: null, resolved_model: null, retry_count: 0, max_retries: 3, error_message: null, git_branch: null, git_worktree: null, git_pr_url: null, git_pr_number: null, next_retry_at: null, started_at: null, completed_at: null, duration_ms: null, prompt_tokens: null, completion_tokens: null, created_at: '2026-01-01', yaml_synced_at: null },
        { ...basePollResponse.tasks[0]!, id: 't2', title: 'Completed Task', status: 'completed', yaml_id: null, project_id: 'p', description: '', priority: 3, type: 'code', model: 'auto', target_files: null, depends_on: null, acceptance_criteria: null, machine_id: null, resolved_model: null, retry_count: 0, max_retries: 3, error_message: null, git_branch: null, git_worktree: null, git_pr_url: null, git_pr_number: null, next_retry_at: null, started_at: null, completed_at: null, duration_ms: null, prompt_tokens: null, completion_tokens: null, created_at: '2026-01-01', yaml_synced_at: null },
      ],
    })
    renderDashboard()
    await waitFor(() => screen.getByText('Backlog Task'))

    // Click "completed" filter button (has count in parens)
    const completedButton = screen.getAllByText(/completed/i).find(el => el.tagName === 'BUTTON')!
    fireEvent.click(completedButton)
    await waitFor(() => {
      expect(screen.getByText('Completed Task')).toBeInTheDocument()
      expect(screen.queryByText('Backlog Task')).not.toBeInTheDocument()
    })
  })

  it('displays scheduler status', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText(/Scheduler active/)).toBeInTheDocument()
    })
  })
})
