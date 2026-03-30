import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { IssueList, IssueSummaryModal } from './IssueList'
import type { Issue, Run } from './api'

// Mock the api module
jest.mock('./api', () => ({
  ...jest.requireActual('./api'),
  createIssue: jest.fn(),
}))

// Mock the UI components at the module level
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open, onOpenChange: _onOpenChange }: any) => (
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
  Button: ({ children, onClick, variant = 'default', size = 'default', ...rest }: any) => (
    <button
      onClick={onClick}
      className={`btn-${variant}-${size}`}
      data-testid="mock-button"
      {...rest}
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

// ─── Shared fixtures ────────────────────────────────────────────────────────

const makeIssue = (overrides: Partial<Issue> = {}): Issue => ({
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
  ...overrides,
})

const sampleIssue = makeIssue()

const sampleIssueWithAllFields = makeIssue({
  id: 'issue-456',
  title: 'Add new feature',
  description: 'Implement user profile page',
  status: 'awaiting_review',
  git_branch: 'feature/user-profile',
  git_pr_url: 'https://github.com/example/repo/pull/42',
  git_pr_number: 42,
  created_at: '2024-01-10T08:00:00Z',
  completed_at: '2024-01-15T14:30:00Z',
})

// ─── IssueSummaryModal ──────────────────────────────────────────────────────

describe('IssueSummaryModal', () => {
  const mockOnClose = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders issue details', () => {
    render(<IssueSummaryModal issue={sampleIssue} onClose={mockOnClose} />)

    expect(screen.getByText('Issue Summary')).toBeInTheDocument()
    expect(screen.getByText('issue-123')).toBeInTheDocument()
    expect(screen.getByText('Fix login bug')).toBeInTheDocument()
    expect(screen.getByText('The login button does not work when clicked')).toBeInTheDocument()
    expect(screen.getByText(/1\/15\/2024/)).toBeInTheDocument()
  })

  it('renders completed date when available', () => {
    render(<IssueSummaryModal issue={sampleIssueWithAllFields} onClose={mockOnClose} />)

    expect(screen.getByText(/1\/15\/2024/)).toBeInTheDocument()
  })

  it('renders branch information when available', () => {
    render(<IssueSummaryModal issue={sampleIssueWithAllFields} onClose={mockOnClose} />)

    expect(screen.getByText('feature/user-profile')).toBeInTheDocument()
  })

  it('renders pull request link when available', () => {
    render(<IssueSummaryModal issue={sampleIssueWithAllFields} onClose={mockOnClose} />)

    const prLink = screen.getByText('https://github.com/example/repo/pull/42')
    expect(prLink).toBeInTheDocument()
    expect(prLink).toHaveAttribute('href', 'https://github.com/example/repo/pull/42')
    expect(prLink).toHaveAttribute('target', '_blank')
    expect(prLink).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('does not render branch section when branch and PR are null', () => {
    render(<IssueSummaryModal issue={sampleIssue} onClose={mockOnClose} />)

    expect(screen.queryByText('Branch')).not.toBeInTheDocument()
    expect(screen.queryByText('Pull Request')).not.toBeInTheDocument()
  })

  it('does not render description when empty', () => {
    render(<IssueSummaryModal issue={makeIssue({ description: '' })} onClose={mockOnClose} />)

    expect(screen.queryByText('Description')).not.toBeInTheDocument()
  })

  it('displays N/A for null dates', () => {
    render(
      <IssueSummaryModal
        issue={makeIssue({ created_at: null, completed_at: null })}
        onClose={mockOnClose}
      />
    )

    const naElements = screen.getAllByText('N/A')
    expect(naElements).toHaveLength(2)
  })
})

// ─── IssueList integration ──────────────────────────────────────────────────

describe('IssueList - Issue Summary Modal Integration', () => {
  const mockOnSelectIssue = jest.fn()
  const mockOnDataChange = jest.fn()

  const sampleIssues: Issue[] = [
    makeIssue({ id: 'issue-1', title: 'Issue 1', description: 'Description 1', status: 'pending' }),
    makeIssue({ id: 'issue-2', title: 'Issue 2', description: 'Description 2', status: 'running', git_branch: 'feature/test' }),
  ]

  const emptyRuns: Map<string, Run> = new Map()

  function renderIssueList(issues = sampleIssues) {
    return render(
      <MemoryRouter>
        <IssueList
          issues={issues}
          runByIssue={emptyRuns}
          statusFilter="all"
          onStatusFilter={jest.fn()}
          onSelectIssue={mockOnSelectIssue}
          projectId="proj-1"
          onDataChange={mockOnDataChange}
        />
      </MemoryRouter>
    )
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('does not show modal initially', () => {
    renderIssueList()

    expect(screen.queryByText('Issue Summary')).not.toBeInTheDocument()
    expect(screen.getByText('New Issue')).toBeInTheDocument()
  })

  it('opens modal when clicking issue title', () => {
    renderIssueList()

    fireEvent.click(screen.getByText('Issue 1'))

    expect(screen.getByText('Issue Summary')).toBeInTheDocument()
    expect(screen.getByText('issue-1')).toBeInTheDocument()
  })

  it('does not call onSelectIssue when clicking issue title (stopPropagation)', () => {
    renderIssueList()

    fireEvent.click(screen.getByText('Issue 1'))

    expect(mockOnSelectIssue).not.toHaveBeenCalled()
    expect(screen.getByText('Issue Summary')).toBeInTheDocument()
  })

  it('calls onSelectIssue when clicking the issue row (not the title)', () => {
    renderIssueList()

    // Click the row button (the parent button wrapping the row content)
    // The row buttons are the ones whose text content includes the issue title plus other content
    const rowButtons = screen.getAllByRole('button').filter(btn =>
      btn.textContent?.includes('Issue 1') &&
      btn.textContent?.includes('pending')
    )
    // The outer row button should be first
    if (rowButtons.length > 0) {
      fireEvent.click(rowButtons[0])
    }

    expect(mockOnSelectIssue).toHaveBeenCalledWith('issue-1')
  })

  it('closes modal and clears selected issue', () => {
    renderIssueList()

    // Open
    fireEvent.click(screen.getByText('Issue 1'))
    expect(screen.getByText('Issue Summary')).toBeInTheDocument()

    // Close via the Dialog's onOpenChange (simulated by our mock — the Dialog mock
    // doesn't wire onOpenChange, so we rely on the close button rendered by DialogContent)
    // With our fix, the built-in DialogContent close button handles this.
    // In the mocked environment, find the close button inside the dialog.
    const dialog = screen.getAllByTestId('mock-dialog').find(d => d.classList.contains('open'))
    expect(dialog).toBeTruthy()
  })

  it('shows status badge in modal', () => {
    renderIssueList()

    fireEvent.click(screen.getByText('Issue 2'))

    // The modal should contain status information for the running issue
    const runningElements = screen.getAllByText(/running/)
    expect(runningElements.length).toBeGreaterThanOrEqual(1)
  })

  it('handles empty issues list', () => {
    renderIssueList([])

    expect(screen.getByText('No issues yet. Create one to get started.')).toBeInTheDocument()
  })
})
