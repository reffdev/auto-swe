import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { Sidebar } from './Sidebar'

// Mock the api module
const mockUpdateAndRestart = jest.fn(() => Promise.resolve({}))
jest.mock('./api', () => ({
  updateAndRestart: () => mockUpdateAndRestart(),
}))

// Mock the dialogs
jest.mock('./Sidebar', () => {
  const actual = jest.requireActual('./Sidebar')
  return {
    ...actual,
    RestartOverlay: () => <div data-testid="mock-restart-overlay">Restarting...</div>,
    NewProjectDialog: () => <div data-testid="mock-new-project-dialog">New Project</div>,
    NewMachineDialog: () => <div data-testid="mock-new-machine-dialog">New Machine</div>,
  }
})

// Mock useNavigate for testing
jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom')
  return {
    ...actual,
    useNavigate: jest.fn(),
  }
})

describe('Sidebar', () => {
  const mockOnSelectProject = jest.fn()
  const mockOnSelectMachine = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockNavigate = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    // Mock fetch for server info
    global.fetch = jest.fn(() =>
      Promise.resolve({
        json: () => Promise.resolve({ commit: 'abc123', branch: 'main' }),
      })
    ) as jest.Mock
    // Mock useNavigate
    ;(useNavigate as jest.Mock).mockImplementation(() => mockNavigate)
  })

  it('renders the sidebar with Auto-SWE header', () => {
    render(
      <MemoryRouter>
        <Sidebar
          projects={[]}
          machines={[]}
          selectedProjectId={null}
          selectedMachineId={null}
          onSelectProject={mockOnSelectProject}
          onSelectMachine={mockOnSelectMachine}
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    expect(screen.getByText('Auto-SWE')).toBeInTheDocument()
    expect(screen.getByText('Autonomous Coding Agents')).toBeInTheDocument()
  })

  it('renders Auto-SWE as a clickable button', () => {
    render(
      <MemoryRouter>
        <Sidebar
          projects={[]}
          machines={[]}
          selectedProjectId={null}
          selectedMachineId={null}
          onSelectProject={mockOnSelectProject}
          onSelectMachine={mockOnSelectMachine}
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    const autoSweButton = screen.getByRole('button', { name: /Auto-SWE/i })
    expect(autoSweButton).toBeInTheDocument()
    expect(autoSweButton).toHaveClass('block', 'text-left')
  })

  it('navigates to root when Auto-SWE button is clicked', () => {
    render(
      <MemoryRouter>
        <Sidebar
          projects={[]}
          machines={[]}
          selectedProjectId={null}
          selectedMachineId={null}
          onSelectProject={mockOnSelectProject}
          onSelectMachine={mockOnSelectMachine}
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    const autoSweButton = screen.getByRole('button', { name: /Auto-SWE/i })
    fireEvent.click(autoSweButton)

    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('renders projects section with header', () => {
    render(
      <MemoryRouter>
        <Sidebar
          projects={[]}
          machines={[]}
          selectedProjectId={null}
          selectedMachineId={null}
          onSelectProject={mockOnSelectProject}
          onSelectMachine={mockOnSelectMachine}
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    expect(screen.getByText('Projects')).toBeInTheDocument()
  })

  it('shows "No projects yet" when no projects', () => {
    render(
      <MemoryRouter>
        <Sidebar
          projects={[]}
          machines={[]}
          selectedProjectId={null}
          selectedMachineId={null}
          onSelectProject={mockOnSelectProject}
          onSelectMachine={mockOnSelectMachine}
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    expect(screen.getByText('No projects yet')).toBeInTheDocument()
  })

  it('renders machines section with header', () => {
    render(
      <MemoryRouter>
        <Sidebar
          projects={[]}
          machines={[]}
          selectedProjectId={null}
          selectedMachineId={null}
          onSelectProject={mockOnSelectProject}
          onSelectMachine={mockOnSelectMachine}
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    expect(screen.getByText('Machines')).toBeInTheDocument()
  })

  it('shows "No machines yet" when no machines', () => {
    render(
      <MemoryRouter>
        <Sidebar
          projects={[]}
          machines={[]}
          selectedProjectId={null}
          selectedMachineId={null}
          onSelectProject={mockOnSelectProject}
          onSelectMachine={mockOnSelectMachine}
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    expect(screen.getByText('No machines yet')).toBeInTheDocument()
  })

  it('renders server info when available', async () => {
    render(
      <MemoryRouter>
        <Sidebar
          projects={[]}
          machines={[]}
          selectedProjectId={null}
          selectedMachineId={null}
          onSelectProject={mockOnSelectProject}
          onSelectMachine={mockOnSelectMachine}
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    // Wait for the fetch to complete
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(screen.getByText('main@abc123')).toBeInTheDocument()
  })

  it('renders Update & Restart button', () => {
    render(
      <MemoryRouter>
        <Sidebar
          projects={[]}
          machines={[]}
          selectedProjectId={null}
          selectedMachineId={null}
          onSelectProject={mockOnSelectProject}
          onSelectMachine={mockOnSelectMachine}
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    expect(screen.getByRole('button', { name: /Update & Restart/i })).toBeInTheDocument()
  })

  it('calls onSelectProject when a project is clicked', () => {
    const projects = [{ id: 'proj1', name: 'Test Project', workdir: '/tmp/test' }]

    render(
      <MemoryRouter>
        <Sidebar
          projects={projects}
          machines={[]}
          selectedProjectId={null}
          selectedMachineId={null}
          onSelectProject={mockOnSelectProject}
          onSelectMachine={mockOnSelectMachine}
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    const projectButton = screen.getByText('Test Project')
    fireEvent.click(projectButton)

    expect(mockOnSelectProject).toHaveBeenCalledWith('proj1')
  })

  it('deselects project when clicking already selected project', () => {
    const projects = [{ id: 'proj1', name: 'Test Project', workdir: '/tmp/test' }]

    render(
      <MemoryRouter>
        <Sidebar
          projects={projects}
          machines={[]}
          selectedProjectId={'proj1'}
          selectedMachineId={null}
          onSelectProject={mockOnSelectProject}
          onSelectMachine={mockOnSelectMachine}
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    const projectButton = screen.getByText('Test Project')
    fireEvent.click(projectButton)

    expect(mockOnSelectProject).toHaveBeenCalledWith(null)
  })

  it('calls onSelectMachine when a machine is clicked', () => {
    const machines = [{ id: 'mach1', name: 'Test Machine', model_id: 'llama3', status: 'idle' }]

    render(
      <MemoryRouter>
        <Sidebar
          projects={[]}
          machines={machines}
          selectedProjectId={null}
          selectedMachineId={null}
          onSelectProject={mockOnSelectProject}
          onSelectMachine={mockOnSelectMachine}
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    const machineButton = screen.getByText('Test Machine')
    fireEvent.click(machineButton)

    expect(mockOnSelectMachine).toHaveBeenCalledWith('mach1')
  })

  it('displays machine status indicator', () => {
    const machines = [
      { id: 'mach1', name: 'Idle Machine', model_id: 'llama3', status: 'idle' },
      { id: 'mach2', name: 'Working Machine', model_id: 'llama3', status: 'working' },
    ]

    render(
      <MemoryRouter>
        <Sidebar
          projects={[]}
          machines={machines}
          selectedProjectId={null}
          selectedMachineId={null}
          onSelectProject={mockOnSelectProject}
          onSelectMachine={mockOnSelectMachine}
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    // Should have two status indicators
    const statusIndicators = document.querySelectorAll('.rounded-full')
    expect(statusIndicators).toHaveLength(2)
  })
})
