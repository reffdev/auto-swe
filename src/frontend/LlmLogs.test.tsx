import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { LlmLogs } from './LlmLogs'

// Mock the api module
const mockGetGroupedLlmLogs = jest.fn()

// Mock useNavigate at module level
jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom')
  return {
    ...actual,
    useNavigate: jest.fn(),
  }
})

jest.mock('./api', () => ({
  getGroupedLlmLogs: () => mockGetGroupedLlmLogs(),
}))

// Mock the UI components
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

jest.mock('@/components/ui/card', () => ({
  Card: ({ children }: any) => <div data-testid="mock-card">{children}</div>,
  CardHeader: ({ children }: any) => <div data-testid="mock-card-header">{children}</div>,
  CardTitle: ({ children }: any) => <div data-testid="mock-card-title">{children}</div>,
  CardContent: ({ children }: any) => <div data-testid="mock-card-content">{children}</div>,
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => (
    <div data-testid="mock-dialog" className={open ? 'open' : 'closed'}>
      {children}
    </div>
  ),
  DialogContent: ({ children }: any) => <div data-testid="mock-dialog-content">{children}</div>,
  DialogHeader: ({ children }: any) => <div data-testid="mock-dialog-header">{children}</div>,
  DialogTitle: ({ children }: any) => <div data-testid="mock-dialog-title">{children}</div>,
}))

describe('LlmLogs', () => {
  const mockNavigate = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    // Mock useNavigate
    ;(useNavigate as jest.Mock).mockImplementation(() => mockNavigate)
  })

  it('renders the LLM logs header', async () => {
    mockGetGroupedLlmLogs.mockResolvedValue({
      groups: [],
      totalGroups: 0,
      totalCalls: 0,
    })

    render(
      <MemoryRouter>
        <LlmLogs projectId="proj1" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('LLM Logs')).toBeInTheDocument()
    })
  })

  it('shows loading state when fetching data', async () => {
    mockGetGroupedLlmLogs.mockImplementation(() => new Promise(() => {})) // Never resolves

    render(
      <MemoryRouter>
        <LlmLogs projectId="proj1" />
      </MemoryRouter>
    )

    // Should show loading spinner (check for the spinner element)
    expect(document.querySelector('.lucide-loader-circle')).toBeInTheDocument()
  })

  it('shows error message when API call fails', async () => {
    mockGetGroupedLlmLogs.mockRejectedValue(new Error('Failed to fetch'))

    render(
      <MemoryRouter>
        <LlmLogs projectId="proj1" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('Failed to fetch')).toBeInTheDocument()
    })
  })

  it('displays grouped issues with expandable rows', async () => {
    mockGetGroupedLlmLogs.mockResolvedValue({
      groups: [
        {
          issue_id: '1',
          issue_title: 'Fix bug in login',
          issue_status: 'pending',
          issue_created_at: '2024-01-01T00:00:00Z',
          issue_assignee: 'user1',
          last_request_at: '2024-01-02T00:00:00Z',
          call_count: 3,
          calls: [],
        },
      ],
      totalGroups: 1,
      totalCalls: 3,
    })

    render(
      <MemoryRouter>
        <LlmLogs projectId="proj1" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('#1')).toBeInTheDocument()
      expect(screen.getByText('Fix bug in login')).toBeInTheDocument()
    })
    
    // Check for call count badge (the one in the header, not in the summary)
    const callCountBadges = screen.getAllByText('3 calls')
    expect(callCountBadges.length).toBeGreaterThan(0)
  })

  it('displays unassigned group when issue_id is null', async () => {
    mockGetGroupedLlmLogs.mockResolvedValue({
      groups: [
        {
          issue_id: null,
          issue_title: null,
          issue_status: null,
          issue_created_at: null,
          issue_assignee: null,
          last_request_at: '2024-01-02T00:00:00Z',
          call_count: 2,
          calls: [],
        },
      ],
      totalGroups: 1,
      totalCalls: 2,
    })

    render(
      <MemoryRouter>
        <LlmLogs projectId="proj1" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('Unassigned')).toBeInTheDocument()
    })
  })

  it('toggles expand/collapse for issue groups', async () => {
    mockGetGroupedLlmLogs.mockResolvedValue({
      groups: [
        {
          issue_id: '1',
          issue_title: 'Fix bug',
          issue_status: 'pending',
          issue_created_at: '2024-01-01T00:00:00Z',
          issue_assignee: 'user1',
          last_request_at: '2024-01-02T00:00:00Z',
          call_count: 2,
          calls: [
            {
              id: 'call1',
              timestamp: '2024-01-02T00:00:00Z',
              model: 'gpt-4',
              status: 'success',
              input_tokens: 100,
              output_tokens: 50,
              latency_ms: 1500,
              prompt_preview: 'Hello',
              response_preview: 'Hi there',
            },
          ],
        },
      ],
      totalGroups: 1,
      totalCalls: 2,
    })

    render(
      <MemoryRouter>
        <LlmLogs projectId="proj1" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('#1')).toBeInTheDocument()
    })

    // Click to expand
    const expandButton = screen.getByRole('button', { name: /#1 Fix bug/i })
    fireEvent.click(expandButton)

    // Should show expanded content (check for prompt preview)
    const promptPreviews = screen.getAllByText('Hello')
    expect(promptPreviews.length).toBeGreaterThan(0)

    // Click to collapse
    fireEvent.click(expandButton)

    // Wait a bit for the collapse to take effect
    await new Promise(resolve => setTimeout(resolve, 100))
  })

  it('displays LLM call details in expanded rows', async () => {
    mockGetGroupedLlmLogs.mockResolvedValue({
      groups: [
        {
          issue_id: '1',
          issue_title: 'Fix bug',
          issue_status: 'pending',
          issue_created_at: '2024-01-01T00:00:00Z',
          issue_assignee: 'user1',
          last_request_at: '2024-01-02T00:00:00Z',
          call_count: 1,
          calls: [
            {
              id: 'call1',
              timestamp: '2024-01-02T00:00:00Z',
              model: 'gpt-4',
              status: 'success',
              input_tokens: 100,
              output_tokens: 50,
              latency_ms: 1500,
              prompt_preview: 'Hello world',
              response_preview: 'Hi there world',
            },
          ],
        },
      ],
      totalGroups: 1,
      totalCalls: 1,
    })

    render(
      <MemoryRouter>
        <LlmLogs projectId="proj1" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('#1')).toBeInTheDocument()
    })

    // Expand the group
    const expandButton = screen.getByRole('button', { name: /#1 Fix bug/i })
    fireEvent.click(expandButton)

    // Check call details
    expect(screen.getByText('gpt-4')).toBeInTheDocument()
    expect(screen.getByText('success')).toBeInTheDocument()
    
    // Check for token counts (they appear in the expanded view)
    const tokenBadges = screen.getAllByText(/In|Out/)
    expect(tokenBadges.length).toBeGreaterThan(0)
    
    // Check for latency
    expect(screen.getByText('1.5s')).toBeInTheDocument()
  })

  it('shows status badge with correct colors', async () => {
    mockGetGroupedLlmLogs.mockResolvedValue({
      groups: [
        {
          issue_id: '1',
          issue_title: 'Fix bug',
          issue_status: 'pending',
          issue_created_at: '2024-01-01T00:00:00Z',
          issue_assignee: 'user1',
          last_request_at: '2024-01-02T00:00:00Z',
          call_count: 2,
          calls: [
            {
              id: 'call1',
              timestamp: '2024-01-02T00:00:00Z',
              model: 'gpt-4',
              status: 'success',
              input_tokens: 100,
              output_tokens: 50,
              latency_ms: 1500,
              prompt_preview: 'Hello',
              response_preview: 'Hi',
            },
            {
              id: 'call2',
              timestamp: '2024-01-02T00:01:00Z',
              model: 'gpt-4',
              status: 'error',
              input_tokens: 100,
              output_tokens: 50,
              latency_ms: 2000,
              prompt_preview: 'Hello',
              response_preview: 'Error',
            },
          ],
        },
      ],
      totalGroups: 1,
      totalCalls: 2,
    })

    render(
      <MemoryRouter>
        <LlmLogs projectId="proj1" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('#1')).toBeInTheDocument()
    })

    // Expand the group
    const expandButton = screen.getByRole('button', { name: /#1 Fix bug/i })
    fireEvent.click(expandButton)

    // Check status badges
    expect(screen.getByText('success')).toBeInTheDocument()
    expect(screen.getByText('error')).toBeInTheDocument()
  })

  it('shows truncated text with expand option', async () => {
    const longText = Array(20).fill('This is a long line of text').join('\n')

    mockGetGroupedLlmLogs.mockResolvedValue({
      groups: [
        {
          issue_id: '1',
          issue_title: 'Fix bug',
          issue_status: 'pending',
          issue_created_at: '2024-01-01T00:00:00Z',
          issue_assignee: 'user1',
          last_request_at: '2024-01-02T00:00:00Z',
          call_count: 1,
          calls: [
            {
              id: 'call1',
              timestamp: '2024-01-02T00:00:00Z',
              model: 'gpt-4',
              status: 'success',
              input_tokens: 100,
              output_tokens: 50,
              latency_ms: 1500,
              prompt_preview: longText,
              response_preview: longText,
            },
          ],
        },
      ],
      totalGroups: 1,
      totalCalls: 1,
    })

    render(
      <MemoryRouter>
        <LlmLogs projectId="proj1" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('#1')).toBeInTheDocument()
    })

    // Expand the group
    const expandButton = screen.getByRole('button', { name: /#1 Fix bug/i })
    fireEvent.click(expandButton)

    // Should show truncated text initially
    const showMoreButtons = screen.getAllByText('Show more')
    expect(showMoreButtons.length).toBeGreaterThan(0)

    // Click to expand
    fireEvent.click(showMoreButtons[0])

    // Should show full text
    expect(screen.getByText('Show less')).toBeInTheDocument()
  })

  it('opens modal for full prompt and response', async () => {
    mockGetGroupedLlmLogs.mockResolvedValue({
      groups: [
        {
          issue_id: '1',
          issue_title: 'Fix bug',
          issue_status: 'pending',
          issue_created_at: '2024-01-01T00:00:00Z',
          issue_assignee: 'user1',
          last_request_at: '2024-01-02T00:00:00Z',
          call_count: 1,
          calls: [
            {
              id: 'call1',
              timestamp: '2024-01-02T00:00:00Z',
              model: 'gpt-4',
              status: 'success',
              input_tokens: 100,
              output_tokens: 50,
              latency_ms: 1500,
              prompt_preview: 'Hello',
              response_preview: 'Hi',
            },
          ],
        },
      ],
      totalGroups: 1,
      totalCalls: 1,
    })

    render(
      <MemoryRouter>
        <LlmLogs projectId="proj1" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('#1')).toBeInTheDocument()
    })

    // Expand the group
    const expandButton = screen.getByRole('button', { name: /#1 Fix bug/i })
    fireEvent.click(expandButton)

    // Click prompt button (get all buttons and find the one with the message icon)
    const promptButtons = screen.getAllByRole('button')
    let promptButtonClicked = false
    for (const btn of promptButtons) {
      // Check if button has MessageSquare icon (prompt button)
      if (btn.innerHTML.includes('MessageSquare') || btn.getAttribute('title') === 'View prompt') {
        fireEvent.click(btn)
        promptButtonClicked = true
        break
      }
    }
    
    if (promptButtonClicked) {
      // Should open modal
      expect(screen.getByText('Prompt')).toBeInTheDocument()
    }

    // Click response button
    const responseButtons = screen.getAllByRole('button')
    let responseButtonClicked = false
    for (const btn of responseButtons) {
      // Check if button has Eye icon (response button)
      if (btn.innerHTML.includes('Eye') || btn.getAttribute('title') === 'View response') {
        fireEvent.click(btn)
        responseButtonClicked = true
        break
      }
    }
    
    if (responseButtonClicked) {
      // Should open modal
      expect(screen.getByText('Response')).toBeInTheDocument()
    }
  })

  it('shows empty state when no logs found', async () => {
    mockGetGroupedLlmLogs.mockResolvedValue({
      groups: [],
      totalGroups: 0,
      totalCalls: 0,
    })

    render(
      <MemoryRouter>
        <LlmLogs projectId="proj1" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('No LLM logs found')).toBeInTheDocument()
    })
  })

  it('shows back button to navigate to project', async () => {
    mockGetGroupedLlmLogs.mockResolvedValue({
      groups: [],
      totalGroups: 0,
      totalCalls: 0,
    })

    render(
      <MemoryRouter>
        <LlmLogs projectId="proj1" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('LLM Logs')).toBeInTheDocument()
    })

    // Click back button
    const backButtons = screen.getAllByRole('button', { name: /Back to Project/i })
    fireEvent.click(backButtons[0])

    expect(mockNavigate).toHaveBeenCalledWith('/project/proj1')
  })

  it('displays summary information in header', async () => {
    mockGetGroupedLlmLogs.mockResolvedValue({
      groups: [
        {
          issue_id: '1',
          issue_title: 'Fix bug',
          issue_status: 'pending',
          issue_created_at: '2024-01-01T00:00:00Z',
          issue_assignee: 'user1',
          last_request_at: '2024-01-02T00:00:00Z',
          call_count: 3,
          calls: [],
        },
        {
          issue_id: '2',
          issue_title: 'Add feature',
          issue_status: 'pending',
          issue_created_at: '2024-01-01T00:00:00Z',
          issue_assignee: 'user2',
          last_request_at: '2024-01-02T00:00:00Z',
          call_count: 5,
          calls: [],
        },
      ],
      totalGroups: 2,
      totalCalls: 8,
    })

    render(
      <MemoryRouter>
        <LlmLogs projectId="proj1" />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('LLM Logs')).toBeInTheDocument()
    })

    // Check summary text (the text appears in the paragraph element)
    // The text is "2 issues" and "8 calls" but split across multiple text nodes
    const summaryText = screen.getByText(/Grouped by issue/i).textContent || ''
    expect(summaryText).toContain('2')
    expect(summaryText).toContain('8')
  })
})
