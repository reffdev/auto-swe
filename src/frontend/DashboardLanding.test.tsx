import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DashboardLanding } from './DashboardLanding'

// Mock EventSource (not available in jsdom)
global.EventSource = jest.fn(() => ({
  onmessage: null,
  onerror: null,
  close: jest.fn(),
})) as any

// Mock the api module - return promises so .then() works
const mockCreateProject = jest.fn(() => Promise.resolve({}))
const mockCreateMachine = jest.fn(() => Promise.resolve({}))

jest.mock('./api', () => ({
  createProject: (args: any) => mockCreateProject(args),
  createMachine: (args: any) => mockCreateMachine(args),
}))

// Mock the card component
jest.mock('@/components/ui/card', () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={`card ${className || ''}`}>{children}</div>
  ),
  CardHeader: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={`card-header ${className || ''}`}>{children}</div>
  ),
  CardTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <h3 className={`card-title ${className || ''}`}>{children}</h3>
  ),
  CardContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={`card-content ${className || ''}`}>{children}</div>
  ),
}))

describe('DashboardLanding', () => {
  const mockOnRefresh = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders the dashboard title and description', () => {
    render(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 0, machines: 0, issues: 0 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )

    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Overview of your autonomous coding agents')).toBeInTheDocument()
  })

  it('renders summary cards with correct counts', () => {
    render(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 3, machines: 2, issues: 5 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )

    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
  })

  it('shows correct singular/plural text for projects', () => {
    const { rerender } = render(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 1, machines: 0, issues: 0 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )
    expect(screen.getByText('project configured')).toBeInTheDocument()

    rerender(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 2, machines: 0, issues: 0 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )
    expect(screen.getByText('projects configured')).toBeInTheDocument()
  })

  it('shows correct singular/plural text for machines', () => {
    const { rerender } = render(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 0, machines: 1, issues: 0 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )
    expect(screen.getByText('agent machine')).toBeInTheDocument()

    rerender(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 0, machines: 2, issues: 0 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )
    expect(screen.getByText('agent machines')).toBeInTheDocument()
  })

  it('shows correct singular/plural text for issues', () => {
    const { rerender } = render(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 0, machines: 0, issues: 1 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )
    expect(screen.getByText('issue tracked')).toBeInTheDocument()

    rerender(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 0, machines: 0, issues: 2 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )
    expect(screen.getByText('issues tracked')).toBeInTheDocument()
  })

  it('renders New Project button', () => {
    render(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 0, machines: 0, issues: 0 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )

    expect(screen.getByRole('button', { name: /New Project/i })).toBeInTheDocument()
  })

  it('renders New Machine button', () => {
    render(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 0, machines: 0, issues: 0 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )

    expect(screen.getByRole('button', { name: /New Machine/i })).toBeInTheDocument()
  })

  it('calls createProject when New Project button is clicked', async () => {
    const mockPrompt = jest.spyOn(window, 'prompt')
    mockPrompt.mockImplementation((prompt) => {
      if (prompt === 'Project name:') return 'Test Project'
      return null
    })

    render(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 0, machines: 0, issues: 0 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )

    const button = screen.getByRole('button', { name: /New Project/i })
    fireEvent.click(button)

    // Wait for the promise to resolve
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockCreateProject).toHaveBeenCalledWith({
      name: 'Test Project',
      workdir: '',
      git_remote: undefined,
      git_server_token: undefined,
      git_default_branch: 'main',
      model_id: undefined,
    })
    expect(mockOnRefresh).toHaveBeenCalled()

    mockPrompt.mockRestore()
  })

  it('calls createMachine when New Machine button is clicked', async () => {
    const mockPrompt = jest.spyOn(window, 'prompt')
    mockPrompt.mockImplementation((prompt: string) => {
      if (prompt === 'Machine name (optional):') return ''
      if (prompt.startsWith('Base URL:')) return 'http://localhost:11434'
      if (prompt.startsWith('Default Model ID')) return 'llama3'
      return null
    })

    render(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 0, machines: 0, issues: 0 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )

    const button = screen.getByRole('button', { name: /New Machine/i })
    fireEvent.click(button)

    // Wait for the promise to resolve
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockCreateMachine).toHaveBeenCalledWith({
      name: '',
      base_url: 'http://localhost:11434',
      model_id: 'llama3',
    })
    expect(mockOnRefresh).toHaveBeenCalled()

    mockPrompt.mockRestore()
  })

  it('shows get started message when no issues', () => {
    render(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 0, machines: 0, issues: 0 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )

    expect(screen.getByText('Get Started')).toBeInTheDocument()
    expect(screen.getByText(/Create a project to start tracking issues/i)).toBeInTheDocument()
  })

  it('does not show get started message when there are issues', () => {
    render(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 0, machines: 0, issues: 1 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )

    expect(screen.queryByText('Get Started')).not.toBeInTheDocument()
  })

  it('renders with correct layout structure', () => {
    render(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 0, machines: 0, issues: 0 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )

    // Check for the main container
    expect(document.body.querySelector('.flex-1')).toBeInTheDocument()
    expect(document.body.querySelector('.flex.flex-col')).toBeInTheDocument()
    expect(document.body.querySelector('.overflow-y-auto')).toBeInTheDocument()
    expect(document.body.querySelector('.p-8')).toBeInTheDocument()
  })

  it('renders three summary cards in a grid', () => {
    render(
      <MemoryRouter>
        <DashboardLanding counts={{ projects: 1, machines: 1, issues: 1 }} onRefresh={mockOnRefresh} />
      </MemoryRouter>
    )

    const grid = document.querySelector('.grid')!
    const cards = grid.querySelectorAll('.card')
    expect(cards).toHaveLength(3)

    // Check that each card has the expected structure
    cards.forEach((card) => {
      expect(card.querySelector('.card-header')).toBeInTheDocument()
      expect(card.querySelector('.card-title')).toBeInTheDocument()
      expect(card.querySelector('.card-content')).toBeInTheDocument()
    })
  })
})
