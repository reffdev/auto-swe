import { useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Plus, FolderGit2, Server, AlertCircle } from 'lucide-react'
import * as api from './api'

interface SummaryCounts {
  projects: number
  machines: number
  issues: number
}

export function DashboardLanding({ counts, onRefresh }: { counts: SummaryCounts; onRefresh: () => void }) {
  const navigate = useNavigate()

  const handleNewProject = () => {
    const name = prompt('Project name:')
    if (name) {
      api.createProject({ name, workdir: '', git_remote: null, git_server_token: null, git_default_branch: 'main', model_id: null })
        .then(() => onRefresh())
    }
  }

  const handleNewMachine = () => {
    const name = prompt('Machine name (optional):')
    const baseUrl = prompt('Base URL:', 'http://localhost:11434')
    const modelId = prompt('Model ID:', 'llama3')
    if (baseUrl && modelId) {
      api.createMachine({
        name: name || '',
        base_url: baseUrl,
        model_id: modelId,
      }).then(() => onRefresh())
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto p-8">
      <div className="max-w-4xl mx-auto w-full space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-muted-foreground mt-1">Overview of your autonomous coding agents</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleNewProject} size="sm">
              <Plus className="size-4 mr-2" />
              New Project
            </Button>
            <Button onClick={handleNewMachine} variant="outline" size="sm">
              <Server className="size-4 mr-2" />
              New Machine
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Projects</CardTitle>
              <FolderGit2 className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{counts.projects}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {counts.projects === 1 ? 'project configured' : 'projects configured'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Machines</CardTitle>
              <Server className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{counts.machines}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {counts.machines === 1 ? 'agent machine' : 'agent machines'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Issues</CardTitle>
              <AlertCircle className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{counts.issues}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {counts.issues === 1 ? 'issue tracked' : 'issues tracked'}
              </p>
            </CardContent>
          </Card>
        </div>

        {counts.issues === 0 && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="size-5 mt-0.5 text-muted-foreground shrink-0" />
                <div>
                  <h3 className="font-medium">Get Started</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Create a project to start tracking issues. Then create an issue to begin autonomous development.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
