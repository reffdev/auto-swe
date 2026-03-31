import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ForemanConfig } from './ForemanConfig'

const mockGetForemanConfig = jest.fn()
const mockUpdateForemanConfig = jest.fn()
const mockPoll = jest.fn()

jest.mock('./api', () => ({
  getForemanConfig: () => mockGetForemanConfig(),
  updateForemanConfig: (data: unknown) => mockUpdateForemanConfig(data),
  poll: () => mockPoll(),
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockPoll.mockResolvedValue({
    projects: [
      { id: 'proj-1', name: 'Dopamine Engine', workdir: '/path', git_remote: null, git_server_token: null, git_default_branch: 'main', model_id: null, build_command: null, test_command: null, lint_command: null, created_at: '2026-01-01' },
    ],
    machines: [],
    issues: [],
    runs: [],
  })
})

function renderConfig() {
  return render(
    <MemoryRouter>
      <ForemanConfig />
    </MemoryRouter>
  )
}

describe('ForemanConfig', () => {
  it('shows loading state', () => {
    mockGetForemanConfig.mockReturnValue(new Promise(() => {}))
    mockPoll.mockReturnValue(new Promise(() => {}))
    renderConfig()
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('renders config form when loaded', async () => {
    mockGetForemanConfig.mockResolvedValue({
      id: 'default',
      enabled: 1,
      project_id: 'proj-1',
      tasks_dir: '/tasks/backlog',
      priority_mode: 'parallel',
      tick_interval_ms: 30000,
      created_at: '2026-01-01',
    })
    renderConfig()
    expect(await screen.findByText('Foreman Configuration')).toBeInTheDocument()
    expect(screen.getByText('Scheduler')).toBeInTheDocument()
    expect(screen.getByText('Target Project')).toBeInTheDocument()
    expect(screen.getByText('Tasks Directory')).toBeInTheDocument()
    expect(screen.getByText('Priority Mode')).toBeInTheDocument()
  })

  it('renders with null config', async () => {
    mockGetForemanConfig.mockResolvedValue(null)
    renderConfig()
    await waitFor(() => {
      expect(screen.getByText('Foreman Configuration')).toBeInTheDocument()
    })
  })

  it('saves config when Save button clicked', async () => {
    mockGetForemanConfig.mockResolvedValue(null)
    mockUpdateForemanConfig.mockResolvedValue({
      id: 'default', enabled: 0, project_id: null, tasks_dir: null,
      priority_mode: 'parallel', tick_interval_ms: 30000, created_at: '2026-01-01',
    })

    renderConfig()
    fireEvent.click(await screen.findByText('Save Configuration'))

    await waitFor(() => {
      expect(mockUpdateForemanConfig).toHaveBeenCalledWith(expect.objectContaining({
        priority_mode: 'parallel',
      }))
    })
  })

  it('shows priority mode options', async () => {
    mockGetForemanConfig.mockResolvedValue(null)
    renderConfig()
    await waitFor(() => {
      expect(screen.getByText('Parallel')).toBeInTheDocument()
      expect(screen.getByText('Yield')).toBeInTheDocument()
      expect(screen.getByText('Exclusive')).toBeInTheDocument()
    })
  })

  it('shows project dropdown with available projects', async () => {
    mockGetForemanConfig.mockResolvedValue(null)
    renderConfig()
    await waitFor(() => {
      expect(screen.getByText('Dopamine Engine')).toBeInTheDocument()
    })
  })
})
