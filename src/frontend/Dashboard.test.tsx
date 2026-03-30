import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { DashboardLayout } from './Dashboard'
import type { ViewName } from './routes'

const TEST_ROUTES: Array<{ path: string; view: ViewName }> = [
  { path: '/', view: 'landing' },
  { path: '/project/:projectId', view: 'issue-list' },
  { path: '/project/:projectId/issue/:issueId', view: 'issue-detail' },
  { path: '/project/:projectId/planner/:conversationId?', view: 'planner' },
  { path: '/project/:projectId/settings', view: 'settings' },
  { path: '/project/:projectId/llm-logs', view: 'llm-logs' },
  { path: '/project/:projectId/analysis', view: 'analysis' },
  { path: '/machine/:machineId', view: 'machine-detail' },
]

function renderWithRouter(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        {TEST_ROUTES.map(({ path, view }) => (
          <Route key={path} path={path} element={<DashboardLayout view={view} />} />
        ))}
      </Routes>
    </MemoryRouter>
  )
}

// Mock the poll hook
jest.mock('./usePoll', () => ({
  usePoll: jest.fn(),
}))

// Mock the child components
jest.mock('./Sidebar', () => ({
  Sidebar: () => <div data-testid="mock-sidebar">Sidebar</div>,
}))

jest.mock('./IssueList', () => ({
  IssueList: () => <div data-testid="mock-issue-list">Issue List</div>,
}))

jest.mock('./IssueDetail', () => ({
  IssueDetail: () => <div data-testid="mock-issue-detail">Issue Detail</div>,
}))

jest.mock('./MachineDetail', () => ({
  MachineDetail: () => <div data-testid="mock-machine-detail">Machine Detail</div>,
}))

jest.mock('./DashboardLanding', () => ({
  DashboardLanding: ({ counts, onRefresh }: { counts: any; onRefresh: () => void }) => (
    <div data-testid="mock-landing">
      <span data-testid="landing-counts">{JSON.stringify(counts)}</span>
      <button onClick={onRefresh} data-testid="landing-refresh">Refresh</button>
    </div>
  ),
}))

jest.mock('./Planner', () => ({
  Planner: () => <div data-testid="mock-planner">Planner</div>,
}))

jest.mock('./ProjectSettings', () => ({
  ProjectSettings: () => <div data-testid="mock-settings">Settings</div>,
}))

jest.mock('./LlmLogs', () => ({
  LlmLogs: () => <div data-testid="mock-llm-logs">LLM Logs</div>,
}))

jest.mock('./AnalysisView', () => ({
  AnalysisView: () => <div data-testid="mock-analysis">Analysis</div>,
}))

describe('Dashboard', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mockUsePoll = require('./usePoll').usePoll as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders the sidebar', () => {
    mockUsePoll.mockReturnValue({
      data: { projects: [], machines: [], issues: [], runs: [] },
      error: null,
      loading: false,
      refresh: jest.fn(),
    })

    renderWithRouter()

    expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument()
  })

  it('shows loading state when data is loading', () => {
    mockUsePoll.mockReturnValue({
      data: null,
      error: null,
      loading: true,
      refresh: jest.fn(),
    })

    renderWithRouter()

    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('shows API error message when there is an error', () => {
    mockUsePoll.mockReturnValue({
      data: null,
      error: 'Failed to fetch data',
      loading: false,
      refresh: jest.fn(),
    })

    renderWithRouter()

    expect(screen.getByText('API error: Failed to fetch data')).toBeInTheDocument()
  })

  it('shows DashboardLanding when no project is selected and no machine selected', () => {
    mockUsePoll.mockReturnValue({
      data: { projects: [], machines: [], issues: [], runs: [] },
      error: null,
      loading: false,
      refresh: jest.fn(),
    })

    renderWithRouter()

    expect(screen.getByTestId('mock-landing')).toBeInTheDocument()
  })

  it('passes correct counts to DashboardLanding', () => {
    mockUsePoll.mockReturnValue({
      data: {
        projects: [{ id: '1', name: 'Test', workdir: '/tmp' }],
        machines: [{ id: '1', name: 'Machine', model_id: 'llama3', status: 'idle' }],
        issues: [{ id: '1', project_id: '1', title: 'Issue 1', status: 'pending' }],
        runs: [],
      },
      error: null,
      loading: false,
      refresh: jest.fn(),
    })

    renderWithRouter()

    const countsElement = screen.getByTestId('landing-counts')
    const counts = JSON.parse(countsElement.textContent || '{}')
    expect(counts).toEqual({ projects: 1, machines: 1, issues: 1 })
  })

  it('calls refresh when DashboardLanding refresh button is clicked', () => {
    const mockRefresh = jest.fn()
    mockUsePoll.mockReturnValue({
      data: { projects: [], machines: [], issues: [], runs: [] },
      error: null,
      loading: false,
      refresh: mockRefresh,
    })

    renderWithRouter()

    const refreshButton = screen.getByTestId('landing-refresh')
    fireEvent.click(refreshButton)

    expect(mockRefresh).toHaveBeenCalled()
  })

  it('shows IssueList when a project is selected', () => {
    mockUsePoll.mockReturnValue({
      data: {
        projects: [{ id: '1', name: 'Test', workdir: '/tmp' }],
        machines: [],
        issues: [],
        runs: [],
      },
      error: null,
      loading: false,
      refresh: jest.fn(),
    })

    renderWithRouter('/project/1')

    expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument()
  })

  it('shows MachineDetail when a machine is selected', () => {
    mockUsePoll.mockReturnValue({
      data: {
        projects: [],
        machines: [{ id: '1', name: 'Machine', model_id: 'llama3', status: 'idle' }],
        issues: [],
        runs: [],
      },
      error: null,
      loading: false,
      refresh: jest.fn(),
    })

    renderWithRouter('/machine/1')

    expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument()
  })

  it('shows IssueDetail when an issue is selected', () => {
    mockUsePoll.mockReturnValue({
      data: {
        projects: [{ id: '1', name: 'Test', workdir: '/tmp' }],
        machines: [],
        issues: [{ id: '1', project_id: '1', title: 'Issue 1', status: 'pending' }],
        runs: [],
      },
      error: null,
      loading: false,
      refresh: jest.fn(),
    })

    renderWithRouter('/project/1/issue/1')

    expect(screen.getByTestId('mock-issue-detail')).toBeInTheDocument()
  })

  it('handles empty state correctly', () => {
    mockUsePoll.mockReturnValue({
      data: { projects: [], machines: [], issues: [], runs: [] },
      error: null,
      loading: false,
      refresh: jest.fn(),
    })

    renderWithRouter()

    // Should show landing page, not "Select a project" message
    expect(screen.getByTestId('mock-landing')).toBeInTheDocument()
    expect(screen.queryByText('Select a project to get started')).not.toBeInTheDocument()
  })
})
