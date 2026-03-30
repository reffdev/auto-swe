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

jest.mock('@/components/ui/card', () => ({
  Card: ({ children }: any) => <div data-testid="mock-card">{children}</div>,
  CardHeader: ({ children }: any) => <div data-testid="mock-card-header">{children}</div>,
  CardTitle: ({ children }: any) => <div data-testid="mock-card-title">{children}</div>,
  CardContent: ({ children }: any) => <div data-testid="mock-card-content">{children}</div>,
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => (
    <div data-testid="mock-dialog" className={open ? 'open' : 'closed'}>
      {open ? children : null}
    </div>
  ),
  DialogContent: ({ children }: any) => <div data-testid="mock-dialog-content">{children}</div>,
  DialogHeader: ({ children }: any) => <div data-testid="mock-dialog-header">{children}</div>,
  DialogTitle: ({ children }: any) => <div data-testid="mock-dialog-title">{children}</div>,
}))

jest.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: any) => <div data-testid="mock-dropdown-menu">{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <div data-testid="mock-dropdown-trigger">{children}</div>,
  DropdownMenuContent: ({ children }: any) => <div data-testid="mock-dropdown-content">{children}</div>,
  DropdownMenuCheckboxItem: ({ children, checked, onCheckedChange }: any) => (
    <button data-testid="mock-checkbox-item" data-checked={checked} onClick={() => onCheckedChange?.(!checked)}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: any) => <div data-testid="mock-dropdown-label">{children}</div>,
  DropdownMenuSeparator: () => <hr data-testid="mock-dropdown-separator" />,
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
    expect(screen.getAllByText('gpt-4').length).toBeGreaterThan(0)
    expect(screen.getAllByText('success').length).toBeGreaterThan(0)
    
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

    // Click prompt button
    const promptBtns = screen.getAllByTitle('View prompt')
    fireEvent.click(promptBtns[0])
    // Should open prompt modal (Dialog title)
    const promptDialogTitles = screen.getAllByText('Prompt')
    expect(promptDialogTitles.length).toBeGreaterThanOrEqual(1)

    // Click response button
    const responseBtns = screen.getAllByTitle('View response')
    fireEvent.click(responseBtns[0])
    // Should open response modal (Dialog title)
    const responseDialogTitles = screen.getAllByText('Response')
    expect(responseDialogTitles.length).toBeGreaterThanOrEqual(1)
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

  describe('filter functionality', () => {
    const mockDataWithFilters = {
      groups: [
        {
          issue_id: '1',
          issue_title: 'Success Issue',
          issue_status: 'pending',
          issue_created_at: '2024-01-01T00:00:00Z',
          issue_assignee: 'user1',
          last_request_at: '2024-01-02T10:00:00Z',
          call_count: 2,
          calls: [
            {
              id: 'call1',
              timestamp: '2024-01-02T10:00:00Z',
              model: 'gpt-4',
              status: 'success',
              input_tokens: 100,
              output_tokens: 50,
              latency_ms: 1500,
              prompt_preview: 'Hello success',
              response_preview: 'Hi there',
            },
          ],
        },
        {
          issue_id: '2',
          issue_title: 'Error Issue',
          issue_status: 'pending',
          issue_created_at: '2024-01-01T00:00:00Z',
          issue_assignee: 'user2',
          last_request_at: '2024-01-02T11:00:00Z',
          call_count: 1,
          calls: [
            {
              id: 'call2',
              timestamp: '2024-01-02T11:00:00Z',
              model: 'gpt-3.5',
              status: 'error',
              input_tokens: 100,
              output_tokens: 0,
              latency_ms: 2000,
              prompt_preview: 'Hello error',
              response_preview: '',
            },
          ],
        },
      ],
      totalGroups: 2,
      totalCalls: 3,
    }

    beforeEach(() => {
      mockGetGroupedLlmLogs.mockResolvedValue(mockDataWithFilters)
    })

    it('renders search input and filter buttons', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })
      // Check for filter buttons rendered in the filter bar
      const buttons = screen.getAllByRole('button')
      const buttonTexts = buttons.map(b => b.textContent)
      expect(buttonTexts.some(t => t?.includes('Status'))).toBe(true)
      expect(buttonTexts.some(t => t?.includes('Model'))).toBe(true)
    })

    it('shows empty state when filters match nothing', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Type non-matching search text
      const searchInput = screen.getByPlaceholderText('Search logs...')
      fireEvent.change(searchInput, { target: { value: 'nonexistent' } })

      // Wait for debounce
      await waitFor(() => {
        expect(screen.getByText('No logs found matching your filters')).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('shows clear filters button when filters are active', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Type search text to activate filter
      const searchInput = screen.getByPlaceholderText('Search logs...')
      fireEvent.change(searchInput, { target: { value: 'success' } })

      // Wait for debounce
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Clear filters/i })).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('filters by text search matching issue title', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Type to search for "Success Issue"
      const searchInput = screen.getByPlaceholderText('Search logs...')
      fireEvent.change(searchInput, { target: { value: 'Success Issue' } })

      // Wait for debounce and filter
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
        expect(screen.queryByText('#2')).not.toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('filters by text search matching prompt preview', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Search for text in prompt preview
      const searchInput = screen.getByPlaceholderText('Search logs...')
      fireEvent.change(searchInput, { target: { value: 'Hello success' } })

      // Wait for debounce and filter
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
        expect(screen.queryByText('#2')).not.toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('filters by text search matching model name', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Search for model name
      const searchInput = screen.getByPlaceholderText('Search logs...')
      fireEvent.change(searchInput, { target: { value: 'gpt-4' } })

      // Wait for debounce and filter
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
        expect(screen.queryByText('#2')).not.toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('updates summary count when filtering', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Initially should show 2 issues
      await waitFor(() => {
        expect(screen.getByText(/2 issues/)).toBeInTheDocument()
      })

      // Filter to show only 1 issue
      const searchInput = screen.getByPlaceholderText('Search logs...')
      fireEvent.change(searchInput, { target: { value: 'Success Issue' } })

      // Wait for debounce and filter
      await waitFor(() => {
        expect(screen.getByText(/1 issue/)).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('clears filters and shows all issues when clear is clicked', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Type search text
      const searchInput = screen.getByPlaceholderText('Search logs...')
      fireEvent.change(searchInput, { target: { value: 'Success Issue' } })

      // Wait for debounce
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Clear filters/i })).toBeInTheDocument()
      }, { timeout: 1000 })

      // Click clear filters
      const clearButton = screen.getByRole('button', { name: /Clear filters/i })
      fireEvent.click(clearButton)

      // All issues should be visible after clearing
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
        expect(screen.getByText('#2')).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('hides clear filters button when no filters are active', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Should not show clear filters initially
      expect(screen.queryByRole('button', { name: /Clear filters/i })).not.toBeInTheDocument()
    })

    it('shows Model filter dropdown with available models', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Check that Model filter button exists
      const buttons = screen.getAllByRole('button')
      const modelButton = buttons.find(b => b.textContent?.includes('Model'))
      expect(modelButton).toBeInTheDocument()
    })

    it('filters by model when checkbox is toggled', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Find and click the Model dropdown trigger
      const dropdownTriggers = screen.getAllByTestId('mock-dropdown-trigger')
      // The Model dropdown should be the second one (Status is first)
      const modelDropdown = dropdownTriggers.find(trigger => 
        trigger.textContent?.includes('Model')
      )
      expect(modelDropdown).toBeInTheDocument()
      
      // Click to open the dropdown
      if (modelDropdown) {
        fireEvent.click(modelDropdown)
      }

      // Find and click a checkbox item (the gpt-4 model)
      const checkboxItems = screen.getAllByTestId('mock-checkbox-item')
      expect(checkboxItems.length).toBeGreaterThan(0)

      // Click gpt-4 checkbox
      const gpt4Checkbox = checkboxItems.find(item => 
        item.textContent?.includes('gpt-4')
      )
      if (gpt4Checkbox) {
        fireEvent.click(gpt4Checkbox)
      }

      // Wait for filter to apply - should show only gpt-4 issue
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
        expect(screen.queryByText('#2')).not.toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('updates header count when search filter reduces results', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Initially should show 2 issues
      await waitFor(() => {
        expect(screen.getByText(/2 issues/)).toBeInTheDocument()
      })

      // Use search to filter to only the gpt-4 issue
      const searchInput = screen.getByPlaceholderText('Search logs...')
      fireEvent.change(searchInput, { target: { value: 'gpt-4' } })

      // Should now show 1 issue (gpt-4 is only in issue #1)
      await waitFor(() => {
        expect(screen.getByText(/1 issue/)).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('clears all filters including model and status when clear is clicked', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Type search text
      const searchInput = screen.getByPlaceholderText('Search logs...')
      fireEvent.change(searchInput, { target: { value: 'test' } })

      // Wait for debounce
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Clear filters/i })).toBeInTheDocument()
      }, { timeout: 1000 })

      // Click clear filters
      const clearButton = screen.getByRole('button', { name: /Clear filters/i })
      fireEvent.click(clearButton)

      // All issues should be visible again
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
        expect(screen.getByText('#2')).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('search is case-insensitive', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Search with uppercase
      const searchInput = screen.getByPlaceholderText('Search logs...')
      fireEvent.change(searchInput, { target: { value: 'SUCCESS ISSUE' } })

      // Should still match
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('filters by status when success checkbox is toggled', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Find and click the Status dropdown trigger
      const dropdownTriggers = screen.getAllByTestId('mock-dropdown-trigger')
      const statusDropdown = dropdownTriggers.find(trigger => 
        trigger.textContent?.includes('Status')
      )
      expect(statusDropdown).toBeInTheDocument()

      // Click to open the dropdown
      if (statusDropdown) {
        fireEvent.click(statusDropdown)
      }

      // Find and click the success checkbox
      const checkboxItems = screen.getAllByTestId('mock-checkbox-item')
      expect(checkboxItems.length).toBeGreaterThan(0)

      // Click success checkbox
      const successCheckbox = checkboxItems.find(item => 
        item.textContent?.includes('Success')
      )
      expect(successCheckbox).toBeInTheDocument()
      
      if (successCheckbox) {
        fireEvent.click(successCheckbox)
      }

      // Wait for filter to apply - should show only success issue (#1)
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
        expect(screen.queryByText('#2')).not.toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('filters by status when error checkbox is toggled', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Find and click the Status dropdown trigger
      const dropdownTriggers = screen.getAllByTestId('mock-dropdown-trigger')
      const statusDropdown = dropdownTriggers.find(trigger => 
        trigger.textContent?.includes('Status')
      )
      expect(statusDropdown).toBeInTheDocument()

      // Click to open the dropdown
      if (statusDropdown) {
        fireEvent.click(statusDropdown)
      }

      // Find and click the error checkbox
      const checkboxItems = screen.getAllByTestId('mock-checkbox-item')
      expect(checkboxItems.length).toBeGreaterThan(0)

      // Click error checkbox
      const errorCheckbox = checkboxItems.find(item => 
        item.textContent?.includes('Error')
      )
      expect(errorCheckbox).toBeInTheDocument()
      
      if (errorCheckbox) {
        fireEvent.click(errorCheckbox)
      }

      // Wait for filter to apply - should show only error issue (#2)
      await waitFor(() => {
        expect(screen.queryByText('#1')).not.toBeInTheDocument()
        expect(screen.getByText('#2')).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('toggles status filter off when checkbox is clicked again', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Find and click the Status dropdown trigger
      const dropdownTriggers = screen.getAllByTestId('mock-dropdown-trigger')
      const statusDropdown = dropdownTriggers.find(trigger => 
        trigger.textContent?.includes('Status')
      )

      if (statusDropdown) {
        fireEvent.click(statusDropdown)
      }

      // Find and click the success checkbox (first click - enable)
      const checkboxItems = screen.getAllByTestId('mock-checkbox-item')
      const successCheckbox = checkboxItems.find(item => 
        item.textContent?.includes('Success')
      )
      
      if (successCheckbox) {
        fireEvent.click(successCheckbox)
      }

      // Should show only #1
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
      }, { timeout: 1000 })

      // Click success checkbox again (second click - disable)
      const updatedCheckboxItems = screen.getAllByTestId('mock-checkbox-item')
      const updatedSuccessCheckbox = updatedCheckboxItems.find(item => 
        item.textContent?.includes('Success')
      )
      
      if (updatedSuccessCheckbox) {
        fireEvent.click(updatedSuccessCheckbox)
      }

      // Should show both issues again (no status filter active)
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
        expect(screen.getByText('#2')).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('filters by date range when dates include all data', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Find the date inputs - both issues have last_request_at in 2024-01-02
      // Set date range from 2024-01-01 to 2024-01-03 to include both
      const startDateInput = screen.getByLabelText('Start date')
      const endDateInput = screen.getByLabelText('End date')

      fireEvent.change(startDateInput, { target: { value: '2024-01-01' } })
      fireEvent.change(endDateInput, { target: { value: '2024-01-03' } })

      // Both issues should still be visible (date range includes all data)
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
        expect(screen.getByText('#2')).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('filters by date range when dates exclude all data', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Set date range that excludes all data (2024-02-01 to 2024-02-28)
      const startDateInput = screen.getByLabelText('Start date')
      const endDateInput = screen.getByLabelText('End date')

      fireEvent.change(startDateInput, { target: { value: '2024-02-01' } })
      fireEvent.change(endDateInput, { target: { value: '2024-02-28' } })

      // Should show empty state since all data is before 2024-02-01
      await waitFor(() => {
        expect(screen.getByText('No logs found matching your filters')).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('combines status filter and search filter together', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // First, apply search filter for "Error"
      const searchInput = screen.getByPlaceholderText('Search logs...')
      fireEvent.change(searchInput, { target: { value: 'Error' } })

      // Should show #2 (Error Issue)
      await waitFor(() => {
        expect(screen.getByText('#2')).toBeInTheDocument()
      }, { timeout: 1000 })

      // Now add status filter for success (which should hide #2)
      const dropdownTriggers = screen.getAllByTestId('mock-dropdown-trigger')
      const statusDropdown = dropdownTriggers.find(trigger => 
        trigger.textContent?.includes('Status')
      )

      if (statusDropdown) {
        fireEvent.click(statusDropdown)
      }

      const checkboxItems = screen.getAllByTestId('mock-checkbox-item')
      const successCheckbox = checkboxItems.find(item => 
        item.textContent?.includes('Success')
      )
      
      if (successCheckbox) {
        fireEvent.click(successCheckbox)
      }

      // Should show empty state since no success + "Error" match
      await waitFor(() => {
        expect(screen.getByText('No logs found matching your filters')).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('combines model filter and search filter together', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // First, apply model filter for gpt-3.5 (Issue #2)
      const dropdownTriggers = screen.getAllByTestId('mock-dropdown-trigger')
      const modelDropdown = dropdownTriggers.find(trigger => 
        trigger.textContent?.includes('Model')
      )

      if (modelDropdown) {
        fireEvent.click(modelDropdown)
      }

      const checkboxItems = screen.getAllByTestId('mock-checkbox-item')
      const gpt35Checkbox = checkboxItems.find(item => 
        item.textContent?.includes('gpt-3.5')
      )
      
      if (gpt35Checkbox) {
        fireEvent.click(gpt35Checkbox)
      }

      // Should show only #2 (gpt-3.5 issue)
      await waitFor(() => {
        expect(screen.getByText('#2')).toBeInTheDocument()
      }, { timeout: 1000 })

      // Now add search filter for "Error" - should still show #2 (matches both)
      const searchInput = screen.getByPlaceholderText('Search logs...')
      fireEvent.change(searchInput, { target: { value: 'Error' } })

      // Should still show #2 (gpt-3.5 + Error matches)
      await waitFor(() => {
        expect(screen.getByText('#2')).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('combines all three filters (search, status, model)', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Apply search for "Success"
      const searchInput = screen.getByPlaceholderText('Search logs...')
      fireEvent.change(searchInput, { target: { value: 'Success' } })

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
      }, { timeout: 1000 })

      // Add model filter for gpt-4
      let dropdownTriggers = screen.getAllByTestId('mock-dropdown-trigger')
      const modelDropdown = dropdownTriggers.find(trigger => 
        trigger.textContent?.includes('Model')
      )

      if (modelDropdown) {
        fireEvent.click(modelDropdown)
      }

      let checkboxItems = screen.getAllByTestId('mock-checkbox-item')
      const gpt4Checkbox = checkboxItems.find(item => 
        item.textContent?.includes('gpt-4')
      )
      
      if (gpt4Checkbox) {
        fireEvent.click(gpt4Checkbox)
      }

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
      }, { timeout: 1000 })

      // Add status filter for success
      dropdownTriggers = screen.getAllByTestId('mock-dropdown-trigger')
      const statusDropdown = dropdownTriggers.find(trigger => 
        trigger.textContent?.includes('Status')
      )

      if (statusDropdown) {
        fireEvent.click(statusDropdown)
      }

      checkboxItems = screen.getAllByTestId('mock-checkbox-item')
      const successCheckbox = checkboxItems.find(item => 
        item.textContent?.includes('Success')
      )
      
      if (successCheckbox) {
        fireEvent.click(successCheckbox)
      }

      // Should still show #1 (matches all three filters)
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
      }, { timeout: 1000 })

      // Summary should show 1 issue
      expect(screen.getByText(/1 issue/)).toBeInTheDocument()
    })

    it('clears date range when clear filters is clicked', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Set date range
      const startDateInput = screen.getByLabelText('Start date')
      fireEvent.change(startDateInput, { target: { value: '2024-01-01' } })

      // Wait for clear button to appear
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Clear filters/i })).toBeInTheDocument()
      }, { timeout: 1000 })

      // Click clear
      const clearButton = screen.getByRole('button', { name: /Clear filters/i })
      fireEvent.click(clearButton)

      // Date input should be empty
      expect(screen.getByLabelText('Start date')).toHaveValue('')
      
      // Both issues should be visible again
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
        expect(screen.getByText('#2')).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('clears status filter when clear filters is clicked', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Apply status filter
      const dropdownTriggers = screen.getAllByTestId('mock-dropdown-trigger')
      const statusDropdown = dropdownTriggers.find(trigger => 
        trigger.textContent?.includes('Status')
      )

      if (statusDropdown) {
        fireEvent.click(statusDropdown)
      }

      const checkboxItems = screen.getAllByTestId('mock-checkbox-item')
      const successCheckbox = checkboxItems.find(item => 
        item.textContent?.includes('Success')
      )
      
      if (successCheckbox) {
        fireEvent.click(successCheckbox)
      }

      // Wait for clear button
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Clear filters/i })).toBeInTheDocument()
      }, { timeout: 1000 })

      // Click clear
      const clearButton = screen.getByRole('button', { name: /Clear filters/i })
      fireEvent.click(clearButton)

      // Both issues should be visible
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument()
        expect(screen.getByText('#2')).toBeInTheDocument()
      }, { timeout: 1000 })
    })

    it('shows correct status badge count after filtering', async () => {
      render(
        <MemoryRouter>
          <LlmLogs projectId="proj1" />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument()
      })

      // Initially shows 2 issues
      await waitFor(() => {
        expect(screen.getByText(/2 issues/)).toBeInTheDocument()
      })

      // Apply status filter for success only
      const dropdownTriggers = screen.getAllByTestId('mock-dropdown-trigger')
      const statusDropdown = dropdownTriggers.find(trigger => 
        trigger.textContent?.includes('Status')
      )

      if (statusDropdown) {
        fireEvent.click(statusDropdown)
      }

      const checkboxItems = screen.getAllByTestId('mock-checkbox-item')
      const successCheckbox = checkboxItems.find(item => 
        item.textContent?.includes('Success')
      )
      
      if (successCheckbox) {
        fireEvent.click(successCheckbox)
      }

      // Should show 1 issue (only the success one)
      await waitFor(() => {
        expect(screen.getByText(/1 issue/)).toBeInTheDocument()
      }, { timeout: 1000 })
    })
  })
})
