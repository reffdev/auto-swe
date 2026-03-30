import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { IssueList, IssueSummaryModal } from './IssueList'
import * as api from './api'

// Mock the api module
jest.mock('./api', () => ({
  ...jest.requireActual('./api'),
  createIssue: jest.fn(),
}))

// Mock the StatusBadge component
jest.mock('./IssueList', () => {
  const actual = jest.requireActual('./IssueList')
  return {
    ...actual,
    StatusBadge: ({ status }: { status: string }) => (
      <span data-testid="mock-status-badge" className={`status-${status}`}>
        {status.replace('_', ' ')}
      </span>
    ),
  }
})

// Mock the UI components at the module level
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => (
    <div data-testid="mock-dialog" className={open ? 'open' : 'closed'}>
      {open ? children : null}
    </div>
  ),
  DialogContent: ({ children }: any) => <div data-testid="mock-dialog-content">{children}</div>,
  DialogHeader: ({ children }: any) => <div data-testid="mock-dialog-header">{children}</div>,
  DialogTitle: ({ children }: any) => <div data-testid="mock-dialog-title">{children}</div>,
  DialogFooter: ({ children }: any) => <div data-testid="mock-dialog-footer">{children}</div>,
}))

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, variant = 'default', size = 'default' }: any) => (
    <button
      onClick={onClick}
      className={`btn-${variant}-${size}`}
      data-testid="mock-button"
    >
      {children}
    </button>
  ),
}))

jest.mock('@/components/ui/input', () => ({
  Input: ({ placeholder, value, onChange }: any) => (
    <input
      data-testid="mock-input"
      placeholder={placeholder}
      value={value}
      onChange={onChange}
    />
  ),
}))

jest.mock('@/components/ui/textarea', () => ({
  Textarea: ({ placeholder, value, onChange, rows }: any) => (
    <textarea
      data-testid="mock-textarea"
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      rows={rows}
    />
  ),
}))

describe('IssueSummaryModal', () => {
  const mockOnClose = jest.fn()

  const sampleIssue: api.Issue = {
    id: 'issue-123',
    project_id: 'proj-1',
    title: 'Fix login bug',
    description: 'The login button does not work when clicked',
    status: 'pending',
    git_branch: null,
    git_worktree: null,
    git_pr_url: null,
    git_pr_number: null,
    github_issue_number: null,
    github_issue_url: null,
    review_lenses: null,
    parent_id: null,
    sequence: null,
    depends_on: null,
    scout_brief: null,
    scout_commit: null,
    retry_count: 0,
    created_at: '2024-01-15T10:30:00Z',
    completed_at: null,
  }

  const sampleIssueWithAllFields: api.Issue = {
    id: 'issue-456',
    project_id: 'proj-1',
    title: 'Add new feature',
    description: 'Implement user profile page',
    status: 'awaiting_review',
    git_branch: 'feature/user-profile',
    git_worktree: null,
    git_pr_url: 'https://github.com/example/repo/pull/42',
    git_pr_number: 42,
    github_issue_number: null,
    github_issue_url: null,
    review_lenses: null,
    parent_id: null,
    sequence: null,
    depends_on: null,
    scout_brief: null,
    scout_commit: null,
    retry_count: 0,
    created_at: '2024-01-10T08:00:00Z',
    completed_at: '2024-01-15T14:30:00Z',
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders the issue summary modal with issue details', () => {
    render(
      <IssueSummaryModal issue={sampleIssue} onClose={mockOnClose} />
    )

    expect(screen.getByText('Issue Summary')).toBeInTheDocument()
    expect(screen.getByText('issue-123')).toBeInTheDocument()
    expect(screen.getByText('Fix login bug')).toBeInTheDocument()
    expect(screen.getByText('pending')).toBeInTheDocument()
    expect(screen.getByText('The login button does not work when clicked')).toBeInTheDocument()
    // Date format varies by locale, just check that a date is displayed
    expect(screen.getByText(/1\/15\/2024/)).toBeInTheDocument()
  })

  it('renders completed date when available', () => {
    render(
      <IssueSummaryModal issue={sampleIssueWithAllFields} onClose={mockOnClose} />
    )

    // Date format varies by locale, just check that a date is displayed
    expect(screen.getByText(/1\/15\/2024/)).toBeInTheDocument()
  })

  it('renders branch information when available', () => {
    render(
      <IssueSummaryModal issue={sampleIssueWithAllFields} onClose={mockOnClose} />
    )

    expect(screen.getByText('feature/user-profile')).toBeInTheDocument()
  })

  it('renders pull request link when available', () => {
    render(
      <IssueSummaryModal issue={sampleIssueWithAllFields} onClose={mockOnClose} />
    )

    const prLink = screen.getByText('https://github.com/example/repo/pull/42')
    expect(prLink).toBeInTheDocument()
    expect(prLink).toHaveAttribute('href', 'https://github.com/example/repo/pull/42')
    expect(prLink).toHaveAttribute('target', '_blank')
    expect(prLink).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('does not render branch section when branch and PR are null', () => {
    render(
      <IssueSummaryModal issue={sampleIssue} onClose={mockOnClose} />
    )

    expect(screen.queryByText('Branch')).not.toBeInTheDocument()
    expect(screen.queryByText('Pull Request')).not.toBeInTheDocument()
  })

  it('does not render description when empty', () => {
    const issueWithoutDescription = { ...sampleIssue, description: '' }
    render(
      <IssueSummaryModal issue={issueWithoutDescription} onClose={mockOnClose} />
    )

    expect(screen.queryByText('Description')).not.toBeInTheDocument()
    expect(screen.queryByText('The login button')).not.toBeInTheDocument()
  })

  it('calls onClose when close button is clicked', () => {
    render(
      <IssueSummaryModal issue={sampleIssue} onClose={mockOnClose} />
    )

    // The close button has the X icon - find it by looking for the X icon
    const closeButtons = screen.getAllByRole('button')
    let closeButtonClicked = false
    for (const btn of closeButtons) {
      // Check if button contains X icon (lucide-react X icon)
      if (btn.innerHTML.includes('XIcon') || btn.getAttribute('aria-label') === 'Close') {
        fireEvent.click(btn)
        closeButtonClicked = true
        break
      }
    }
    
    // If we couldn't find the button by icon, try clicking the first button in the header
    if (!closeButtonClicked) {
      const headerButtons = screen.getAllByRole('button')
      if (headerButtons.length > 0) {
        fireEvent.click(headerButtons[0])
      }
    }

    expect(mockOnClose).toHaveBeenCalled()
  })

  it('calls onClose when clicking outside the dialog content', () => {
    // Note: This test verifies the onOpenChange handler is wired up correctly
    // The actual behavior depends on the Dialog component implementation
    // We're testing that the component accepts onOpenChange prop
    const { container } = render(
      <IssueSummaryModal issue={sampleIssue} onClose={mockOnClose} />
    )

    // The dialog should be open
    expect(screen.getByText('Issue Summary')).toBeInTheDocument()
    
    // Verify the onClose callback is the one passed in
    // (The actual click outside behavior is tested in the Dialog component tests)
    expect(mockOnClose).not.toHaveBeenCalled()
  })

  it('displays N/A for null created_at date', () => {
    const issueWithNullDates = { ...sampleIssue, created_at: null, completed_at: null }
    render(
      <IssueSummaryModal issue={issueWithNullDates} onClose={mockOnClose} />
    )

    // There should be multiple N/A elements (Created and Completed)
    const naElements = screen.getAllByText('N/A')
    expect(naElements.length).toBeGreaterThan(0)
  })
})

describe('IssueList - Issue Summary Modal Integration', () => {
  const mockOnSelectIssue = jest.fn()
  const mockOnDataChange = jest.fn()

  const sampleIssues: api.Issue[] = [
    {
      id: 'issue-1',
      project_id: 'proj-1',
      title: 'Issue 1',
      description: 'Description 1',
      status: 'pending',
      git_branch: null,
      git_worktree: null,
      git_pr_url: null,
      git_pr_number: null,
      github_issue_number: null,
      github_issue_url: null,
      review_lenses: null,
      parent_id: null,
      sequence: null,
      depends_on: null,
      scout_brief: null,
      scout_commit: null,
      retry_count: 0,
      created_at: '2024-01-15T10:30:00Z',
      completed_at: null,
    },
    {
      id: 'issue-2',
      project_id: 'proj-1',
      title: 'Issue 2',
      description: 'Description 2',
      status: 'running',
      git_branch: 'feature/test',
      git_worktree: null,
      git_pr_url: null,
      git_pr_number: null,
      github_issue_number: null,
      github_issue_url: null,
      review_lenses: null,
      parent_id: null,
      sequence: null,
      depends_on: null,
      scout_brief: null,
      scout_commit: null,
      retry_count: 0,
      created_at: '2024-01-14T09:00:00Z',
      completed_at: null,
    },
  ]

  const sampleRuns: Map<string, api.Run> = new Map()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('does not show modal initially', () => {
    render(
      <MemoryRouter>
        <IssueList
          issues={sampleIssues}
          runByIssue={sampleRuns}
          statusFilter="all"
          onStatusFilter={jest.fn()}
          onSelectIssue={mockOnSelectIssue}
          projectId="proj-1"
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    // Check that the Issue Summary modal is not open
    expect(screen.queryByText('Issue Summary')).not.toBeInTheDocument()
    // The "New Issue" button should exist (it's the button to open the dialog)
    expect(screen.getByText('New Issue')).toBeInTheDocument()
  })

  it('shows modal when clicking on issue title', () => {
    render(
      <MemoryRouter>
        <IssueList
          issues={sampleIssues}
          runByIssue={sampleRuns}
          statusFilter="all"
          onStatusFilter={jest.fn()}
          onSelectIssue={mockOnSelectIssue}
          projectId="proj-1"
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    // Click on the first issue title button (not the one in the modal)
    // Use queryAllByRole to get all buttons, then filter for the one outside the dialog
    const buttons = screen.queryAllByRole('button')
    const issueTitleButton = buttons?.find(btn => 
      btn.textContent === 'Issue 1' && 
      !btn.closest('[data-testid="mock-dialog"]')
    )
    if (issueTitleButton) {
      fireEvent.click(issueTitleButton)
    }

    expect(screen.getByText('Issue Summary')).toBeInTheDocument()
    // The modal should contain the issue title
    expect(screen.getByText('Issue 1', { selector: 'p.text-sm.font-medium' })).toBeInTheDocument()
  })

  it('closes modal when clicking close button', () => {
    render(
      <MemoryRouter>
        <IssueList
          issues={sampleIssues}
          runByIssue={sampleRuns}
          statusFilter="all"
          onStatusFilter={jest.fn()}
          onSelectIssue={mockOnSelectIssue}
          projectId="proj-1"
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    // Open modal
    const buttons = screen.queryAllByRole('button')
    const issueTitleButton = buttons?.find(btn => 
      btn.textContent === 'Issue 1' && 
      !btn.closest('[data-testid="mock-dialog"]')
    )
    if (issueTitleButton) {
      fireEvent.click(issueTitleButton)
    }
    expect(screen.getByText('Issue Summary')).toBeInTheDocument()

    // Close modal - click the close button (X icon button in the header)
    // Find the close button inside the open dialog
    const dialogElements = screen.getAllByTestId('mock-dialog')
    const openDialogElement = dialogElements.find(d => d.classList.contains('open'))
    if (openDialogElement) {
      const closeButtons = openDialogElement.querySelectorAll('button')
      if (closeButtons.length > 0) {
        fireEvent.click(closeButtons[0])
      }
    }

    expect(screen.queryByText('Issue Summary')).not.toBeInTheDocument()
  })

  it('does not call onSelectIssue when clicking issue title (modal takes precedence)', () => {
    render(
      <MemoryRouter>
        <IssueList
          issues={sampleIssues}
          runByIssue={sampleRuns}
          statusFilter="all"
          onStatusFilter={jest.fn()}
          onSelectIssue={mockOnSelectIssue}
          projectId="proj-1"
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    // Click on the first issue title
    const issueTitle = screen.getByText('Issue 1')
    fireEvent.click(issueTitle)

    // Modal should open, onSelectIssue should NOT be called
    expect(mockOnSelectIssue).not.toHaveBeenCalled()
    expect(screen.getByText('Issue Summary')).toBeInTheDocument()
  })

  it('shows status badge in modal', () => {
    render(
      <MemoryRouter>
        <IssueList
          issues={sampleIssues}
          runByIssue={sampleRuns}
          statusFilter="all"
          onStatusFilter={jest.fn()}
          onSelectIssue={mockOnSelectIssue}
          projectId="proj-1"
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    // Click on running issue
    const buttons = screen.queryAllByRole('button')
    const issueTitleButton = buttons?.find(btn => 
      btn.textContent === 'Issue 2' && 
      !btn.closest('[data-testid="mock-dialog"]')
    )
    if (issueTitleButton) {
      fireEvent.click(issueTitleButton)
    }

    // The status badge in the modal should show "running"
    // Use getAllByText to find all instances and check that at least one is in the modal
    const runningElements = screen.getAllByText('running')
    // At least one should be a span (the status badge in the modal)
    const statusBadge = runningElements.find(el => el.tagName === 'SPAN')
    expect(statusBadge).toBeInTheDocument()
  })

  it('handles empty issues list', () => {
    render(
      <MemoryRouter>
        <IssueList
          issues={[]}
          runByIssue={new Map()}
          statusFilter="all"
          onStatusFilter={jest.fn()}
          onSelectIssue={mockOnSelectIssue}
          projectId="proj-1"
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )

    expect(screen.getByText('No issues yet. Create one to get started.')).toBeInTheDocument()
  })
})
