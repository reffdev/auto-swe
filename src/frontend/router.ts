import * as React from 'react'

type ViewState =
  | { type: 'empty' }
  | { type: 'project'; projectId: string }
  | { type: 'project-issue'; projectId: string; issueId: string }
  | { type: 'machine'; machineId: string }

function parseHash(): ViewState {
  const hash = window.location.hash.slice(1) // Remove leading '#'
  const parts = hash.split('/').filter(Boolean)

  if (parts.length === 0) {
    return { type: 'empty' }
  }

  if (parts[0] === 'project' && parts.length === 2) {
    return { type: 'project', projectId: parts[1] }
  }

  if (parts[0] === 'project' && parts[1] === 'issue' && parts.length === 3) {
    return { type: 'project-issue', projectId: parts[1], issueId: parts[2] }
  }

  if (parts[0] === 'machine' && parts.length === 2) {
    return { type: 'machine', machineId: parts[1] }
  }

  return { type: 'empty' }
}

function formatHash(viewState: ViewState): string {
  switch (viewState.type) {
    case 'empty':
      return '#/'
    case 'project':
      return `#/project/${viewState.projectId}`
    case 'project-issue':
      return `#/project/${viewState.projectId}/issue/${viewState.issueId}`
    case 'machine':
      return `#/machine/${viewState.machineId}`
  }
}

export function getHash(): string {
  return window.location.hash
}

export function setHash(viewState: ViewState): void {
  window.location.hash = formatHash(viewState)
}

export function navigateToProject(projectId: string): void {
  setHash({ type: 'project', projectId })
}

export function navigateToIssue(projectId: string, issueId: string): void {
  setHash({ type: 'project-issue', projectId, issueId })
}

export function navigateToMachine(machineId: string): void {
  setHash({ type: 'machine', machineId })
}

export function navigateToEmpty(): void {
  setHash({ type: 'empty' })
}

export function useHashRouting(
  onNavigate: (viewState: ViewState) => void
): void {
  React.useEffect(() => {
    const handleHashChange = () => {
      onNavigate(parseHash())
    }

    // Initial navigation based on current hash
    onNavigate(parseHash())

    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [onNavigate])
}
