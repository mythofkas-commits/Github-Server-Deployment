import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Settings, GitBranch, Server, Globe, Plus, Upload, Eye, Clock, Trash2, RotateCcw, Terminal, FileText } from 'lucide-react';

const normalizeApiBase = (base) => {
  if (!base || typeof base !== 'string') return '';
  const trimmed = base.trim();
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
};

const sanitizeGitHubRepoUrl = (rawValue) => {
  if (!rawValue || typeof rawValue !== 'string') return null;
  try {
    const url = new URL(rawValue.trim());
    if (url.protocol !== 'https:') return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'github.com' && hostname !== 'www.github.com') return null;
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length < 2) return null;
    const owner = pathParts[0];
    const segmentPattern = /^[A-Za-z0-9_.-]+$/;
    if (!segmentPattern.test(owner)) return null;
    const repo = pathParts[1].replace(/\.git$/i, '');
    if (!segmentPattern.test(repo)) return null;
    return `https://github.com/${owner}/${repo}`;
  } catch {
    return null;
  }
};

const describeHttpError = async (response) => {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const data = await response.clone().json();
      if (data?.error) return data.error;
      if (data?.message) return data.message;
      const serialized = JSON.stringify(data);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // fall through to text parsing
    }
  }
  try {
    const text = (await response.text()).trim();
    if (text) return text;
  } catch {
    // ignore
  }
  return `Request failed with status ${response.status}`;
};

const detectApiBase = () => {
  const envBase = normalizeApiBase(process.env.REACT_APP_API_BASE);
  if (envBase) return envBase;

  if (typeof window !== 'undefined') {
    const globalOverride = normalizeApiBase(window.DEPLOYER_API_BASE || window.__DEPLOYER_API_BASE);
    if (globalOverride) return globalOverride;

    const origin = window.location?.origin || '';
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
    if (isLocalhost) {
      return 'http://localhost:3002/api';
    }
  }

  return '/deployer/api';
};

const API_BASE = detectApiBase();

const DeploymentDashboard = () => {
  const [projects, setProjects] = useState([]);
  const [view, setView] = useState('dashboard');
  const [selectedProject, setSelectedProject] = useState(null);
  const [loading, setLoading] = useState(false);
  const [deployingProjects, setDeployingProjects] = useState(new Set());
  const [deploymentStatus, setDeploymentStatus] = useState({});
  const [deploymentHistory, setDeploymentHistory] = useState({});
  const [logViewer, setLogViewer] = useState({ open: false, deploymentId: null, content: '', loading: false, error: '' });
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [settingsForm, setSettingsForm] = useState(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsAlert, setSettingsAlert] = useState({ type: '', message: '' });
  const [envEntries, setEnvEntries] = useState([{ key: '', value: '', isSecret: false, hasValue: false, id: 'env-0' }]);
  const [envSaving, setEnvSaving] = useState(false);
  const [envAlert, setEnvAlert] = useState({ type: '', message: '' });

  // SAFETY: track pending timeouts to avoid setState on unmounted component
  const timeoutsRef = useRef(new Map());
  const createEnvEntry = useCallback((entry = {}) => ({
    key: entry.key || '',
    value: entry.isSecret ? '' : (entry.value || ''),
    isSecret: !!entry.isSecret,
    hasValue: entry.isSecret ? !!entry.hasValue : !!(entry.value && entry.value.length > 0),
    id: entry.id || `env-${Math.random().toString(36).slice(2)}`
  }), []);

  const loadProjects = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/projects`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json().catch(() => {
        throw new Error('Invalid JSON from /projects');
      });
      setProjects(Array.isArray(data) ? data : []);
    } catch {
      // Fallback demo data on failure (kept from your original)
      setProjects([
        { id: 1, name: 'portfolio-site', repo: 'username/portfolio-site', status: 'success', lastDeploy: '2 hours ago', branch: 'main', target: 'server', stack: ['React', 'TypeScript'], buildCommand: 'npm run build', deployPath: '/var/www/portfolio' },
        { id: 2, name: 'api-gateway', repo: 'username/api-gateway', status: 'success', lastDeploy: '1 day ago', branch: 'main', target: 'server', stack: ['Node.js', 'Express'], buildCommand: 'npm install', deployPath: '/var/www/api' },
        { id: 3, name: 'docs-website', repo: 'username/docs-website', status: 'failed', lastDeploy: '1 day ago', branch: 'main', target: 'github-pages', stack: ['HTML', 'CSS', 'JavaScript'], buildCommand: 'npm run build', deployPath: 'gh-pages' }
      ]);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  const fetchProjectDeployments = useCallback(async (projectId) => {
    if (!projectId) return;
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/deployments?limit=10`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDeploymentHistory(prev => ({ ...prev, [projectId]: Array.isArray(data) ? data : [] }));
    } catch (error) {
      console.error('Failed to load deployments', error);
    }
  }, []);

  const pollDeployment = useCallback((projectId, deploymentId) => {
    if (!projectId || !deploymentId) return;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/deployments/${deploymentId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setDeploymentStatus(prev => ({ ...prev, [projectId]: data }));
        if (data.status === 'success' || data.status === 'failed') {
          const existingTimeout = timeoutsRef.current.get(deploymentId);
          if (existingTimeout) {
            clearTimeout(existingTimeout);
            timeoutsRef.current.delete(deploymentId);
          }
          setDeployingProjects(prev => {
            const next = new Set(prev);
            next.delete(projectId);
            return next;
          });
          await fetchProjectDeployments(projectId);
          await loadProjects();
        } else {
          const timeout = setTimeout(poll, 3000);
          timeoutsRef.current.set(deploymentId, timeout);
        }
      } catch (error) {
        console.error('Failed to poll deployment', error);
        const existingTimeout = timeoutsRef.current.get(deploymentId);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
          timeoutsRef.current.delete(deploymentId);
        }
        setDeploymentStatus(prev => ({ ...prev, [projectId]: { deploymentId, status: 'failed', error: error.message } }));
        setDeployingProjects(prev => {
          const next = new Set(prev);
          next.delete(projectId);
          return next;
        });
      }
    };
    poll();
  }, [fetchProjectDeployments, loadProjects]);

  const fetchProjectDetail = useCallback(async (projectId) => {
    if (!projectId) return null;
    const res = await fetch(`${API_BASE}/projects/${projectId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, []);

  // SAFETY: clear any pending timers on unmount
  useEffect(() => {
    const timers = timeoutsRef.current;
    return () => {
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (selectedProject?.id) {
      fetchProjectDeployments(selectedProject.id);
    }
  }, [selectedProject, fetchProjectDeployments]);

  useEffect(() => {
    if (!selectedProject) {
      setSettingsForm(null);
      setEnvEntries([{ key: '', value: '' }]);
      return;
    }
    setSettingsForm({
      name: selectedProject.name || '',
      description: selectedProject.description || '',
      repoUrl: selectedProject.repo || '',
      branch: selectedProject.branch || '',
      buildCommand: selectedProject.buildCommand || '',
      buildOutput: selectedProject.buildOutput || '',
      installCommand: selectedProject.installCommand || '',
      testCommand: selectedProject.testCommand || '',
      startCommand: selectedProject.startCommand || '',
      deployPath: selectedProject.deployPath || '',
      runtime: selectedProject.runtime || 'static',
      domain: selectedProject.domain || '',
      port: selectedProject.port ? String(selectedProject.port) : '',
      target: selectedProject.target || 'server'
    });
    const envArray = Array.isArray(selectedProject.env) ? selectedProject.env : [];
    const entries = envArray.map((item) => createEnvEntry(item));
    setEnvEntries(entries.length ? entries : [createEnvEntry()]);
    setSettingsAlert({ type: '', message: '' });
    setEnvAlert({ type: '', message: '' });
  }, [selectedProject, createEnvEntry]);

  const getStatusColor = (status) => {
    switch(status) {
      case 'success': return 'bg-green-100 text-green-800 border-green-300';
      case 'failed': return 'bg-red-100 text-red-800 border-red-300';
      case 'deploying':
      case 'running':
      case 'queued':
        return 'bg-blue-100 text-blue-800 border-blue-300';
      default: return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  const handleDeploy = async (projectId, options = {}) => {
    if (!projectId || deployingProjects.has(projectId)) return;

    setDeployingProjects(prev => new Set(prev).add(projectId));
    setProjects(prev =>
      prev.map(p => p.id === projectId ? { ...p, status: 'deploying', lastDeploy: 'Deploying now' } : p)
    );
    setSelectedProject(prev => (prev?.id === projectId ? { ...prev, status: 'deploying', lastDeploy: 'Deploying now' } : prev));

    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDeploymentStatus(prev => ({ ...prev, [projectId]: data }));
      pollDeployment(projectId, data.deploymentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start deployment';
      alert(message);
      setDeploymentStatus(prev => ({ ...prev, [projectId]: { status: 'failed', error: message } }));
      setDeployingProjects(prev => {
        const next = new Set(prev);
        next.delete(projectId);
        return next;
      });
      setProjects(prev => prev.map(p => p.id === projectId ? { ...p, status: 'failed', lastDeploy: 'Deployment failed' } : p));
      setSelectedProject(prev => (prev?.id === projectId ? { ...prev, status: 'failed' } : prev));
    }
  };

  const handleRollback = async (projectId) => {
    if (!projectId) return;
    if (!window.confirm('Rollback to the previous release?')) return;
    setRollbackLoading(true);
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/rollback`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchProjectDeployments(projectId);
      await loadProjects();
      alert('Rollback completed and nginx reloaded.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Rollback failed';
      alert(message);
    } finally {
      setRollbackLoading(false);
    }
  };

  const openLogs = async (deploymentId) => {
    if (!deploymentId) return;
    setLogViewer({ open: true, deploymentId, content: '', loading: true, error: '' });
    try {
      const res = await fetch(`${API_BASE}/deployments/${deploymentId}/log`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      setLogViewer({ open: true, deploymentId, content: text || 'No logs available yet.', loading: false, error: '' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load logs';
      setLogViewer({ open: true, deploymentId, content: '', loading: false, error: message });
    }
  };

  const closeLogViewer = () => setLogViewer({ open: false, deploymentId: null, content: '', loading: false, error: '' });

  const openProjectView = useCallback(async (project, nextView) => {
    if (!project?.id) return;
    setSelectedProject(project);
    setView(nextView);
    try {
      const detail = await fetchProjectDetail(project.id);
      if (detail) {
        setSelectedProject(detail);
        setProjects(prev => prev.map(p => p.id === detail.id ? detail : p));
        if (nextView === 'logs') {
          fetchProjectDeployments(detail.id);
        }
      }
    } catch (error) {
      console.error('Failed to load project detail', error);
    }
  }, [fetchProjectDetail, fetchProjectDeployments]);

  const handleDeleteProject = async (projectId) => {
    if (!projectId) return; // SAFETY
    if (!window.confirm('Are you sure you want to delete this project?')) return;
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setProjects(prev => prev.filter(p => p.id !== projectId));
      if (selectedProject?.id === projectId) { setSelectedProject(null); setView('dashboard'); }
    } catch (err) {
      alert('Failed to delete: ' + (err?.message || 'Unknown error'));
    }
  };

  const updateSettingsField = (field, value) => {
    setSettingsForm(prev => ({ ...(prev || {}), [field]: value }));
  };

  const saveProjectSettings = async () => {
    if (!selectedProject?.id || !settingsForm) return;
    setSettingsSaving(true);
    setSettingsAlert({ type: '', message: '' });
    try {
      const payload = {
        name: settingsForm.name?.trim(),
        description: settingsForm.description?.trim(),
        repoUrl: settingsForm.repoUrl?.trim(),
        branch: settingsForm.branch?.trim(),
        buildCommand: settingsForm.buildCommand?.trim(),
        buildOutput: settingsForm.buildOutput?.trim(),
        installCommand: settingsForm.installCommand || '',
        testCommand: settingsForm.testCommand || '',
        startCommand: settingsForm.startCommand || '',
        deployPath: settingsForm.deployPath?.trim(),
        runtime: settingsForm.runtime,
        domain: settingsForm.domain?.trim(),
        port: settingsForm.port ? Number(settingsForm.port) : null,
        target: settingsForm.target
      };
      const res = await fetch(`${API_BASE}/projects/${selectedProject.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const detail = await describeHttpError(res);
        throw new Error(detail);
      }
      const updated = await res.json();
      setSelectedProject(updated);
      setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
      setSettingsAlert({ type: 'success', message: 'Settings saved' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save settings';
      setSettingsAlert({ type: 'error', message });
    } finally {
      setSettingsSaving(false);
    }
  };

  const addEnvEntry = () => {
    setEnvEntries(prev => [...prev, createEnvEntry()]);
  };

  const updateEnvEntry = (index, field, value) => {
    setEnvEntries(prev => prev.map((entry, idx) => idx === index ? { ...entry, [field]: value } : entry));
  };

  const removeEnvEntry = (index) => {
    setEnvEntries(prev => {
      const next = prev.filter((_, idx) => idx !== index);
      return next.length ? next : [];
    });
  };

  const toggleSecretFlag = (index, checked) => {
    setEnvEntries(prev => prev.map((entry, idx) => {
      if (idx !== index) return entry;
      if (!checked) {
        if (entry.isSecret && entry.hasValue) {
          return entry;
        }
        return { ...entry, isSecret: false };
      }
      return { ...entry, isSecret: true };
    }));
  };

  const saveEnvironment = async () => {
    if (!selectedProject?.id) return;
    setEnvSaving(true);
    setEnvAlert({ type: '', message: '' });
    try {
      const trimmedEntries = envEntries.filter(entry => entry.key.trim());
      const existingKeys = Array.isArray(selectedProject?.env) ? selectedProject.env.filter(item => item?.key).length : 0;
      const missingSecret = trimmedEntries.find(entry => entry.isSecret && !entry.value && !entry.hasValue);
      if (missingSecret) {
        throw new Error(`Secret ${missingSecret.key} requires a value`);
      }
      if (trimmedEntries.length === 0 && existingKeys === 0) {
        setEnvAlert({ type: 'info', message: 'No environment variables to update.' });
        return;
      }
      const envPayload = trimmedEntries.map(entry => {
        const base = { key: entry.key.trim(), isSecret: !!entry.isSecret };
        if (base.isSecret) {
          if (entry.value) {
            base.value = entry.value;
          }
        } else {
          base.value = entry.value ?? '';
        }
        return base;
      });
      const res = await fetch(`${API_BASE}/projects/${selectedProject.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env: envPayload })
      });
      if (!res.ok) {
        const detail = await describeHttpError(res);
        throw new Error(detail);
      }
      const updated = await res.json();
      setSelectedProject(updated);
      setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
      setEnvAlert({ type: 'success', message: 'Environment updated' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save environment';
      setEnvAlert({ type: 'error', message });
    } finally {
      setEnvSaving(false);
    }
  };

  const DashboardView = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Your Projects</h2>
          <p className="text-gray-600 mt-1">{projects.length} active deployment{projects.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex gap-3">
          <button onClick={() => setView('import')} className="flex items-center gap-2 px-4 py-2 bg-white border-2 border-gray-300 rounded-lg hover:border-blue-500 hover:text-blue-600 transition-colors">
            <Upload className="w-4 h-4" />Import Project
          </button>
          <button onClick={() => setView('create')} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            <Plus className="w-4 h-4" />New Project
          </button>
        </div>
      </div>

      <div className="grid gap-4">
        {projects.map(project => {
          const liveStatus = deploymentStatus[project.id]?.status || project.status;
          const statusLabel = liveStatus ? liveStatus.toString() : 'unknown';
          return (
          <div key={project.id} className="bg-white rounded-lg border-2 border-gray-200 p-5 hover:border-blue-300 transition-all">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <h3 className="text-lg font-semibold text-gray-900">{project.name}</h3>
                  <span className={`px-2 py-1 rounded text-xs font-medium border ${getStatusColor(liveStatus)}`}>{statusLabel}</span>
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-600 mb-3">
                  <span className="flex items-center gap-1"><GitBranch className="w-4 h-4" />{project.repo}</span>
                  <span className="flex items-center gap-1">
                    {/* FIX: handle 'both' target gracefully */}
                    {project.target === 'server' && <Server className="w-4 h-4" />}
                    {project.target === 'github-pages' && <Globe className="w-4 h-4" />}
                    {project.target === 'both' && (<><Server className="w-4 h-4" /><Globe className="w-4 h-4" /></>)}
                    {project.target === 'server' ? 'Nginx Server' : project.target === 'github-pages' ? 'GitHub Pages' : project.target === 'both' ? 'Server + GitHub Pages' : 'Unknown'}
                  </span>
                  <span>Branch: {project.branch}</span>
                </div>
                <div className="flex items-center gap-2 mb-2">
                  {project.stack?.map((tech, i) => <span key={i} className="px-2 py-1 bg-gray-100 text-gray-700 rounded text-xs font-medium">{tech}</span>)}
                </div>
                <p className="text-sm text-gray-500">Last deployed: {project.lastDeploy || 'Never'}</p>
                {deploymentStatus[project.id]?.error && (
                  <p className="text-xs text-red-600 mt-1">Error: {deploymentStatus[project.id].error}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => openProjectView(project, 'logs')} className="p-2 hover:bg-gray-100 rounded-lg transition-colors"><Eye className="w-5 h-5 text-gray-600" /></button>
                <button onClick={() => openProjectView(project, 'settings')} className="p-2 hover:bg-gray-100 rounded-lg transition-colors"><Settings className="w-5 h-5 text-gray-600" /></button>
                <button
                  onClick={() => handleDeploy(project.id)}
                  disabled={deployingProjects.has(project.id)}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                >
                  {deployingProjects.has(project.id) ? <><Clock className="w-4 h-4 animate-spin" />Deploying...</> : <><Play className="w-4 h-4" />Deploy</>}
                </button>
              </div>
            </div>
          </div>
        )})}
      </div>
    </div>
  );

  const CreateProjectView = () => {
    const [formData, setFormData] = useState({ name: '', template: 'react', target: 'server', description: '' });
    
    const handleCreate = async () => {
      if (!formData.name) return;
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/projects/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formData) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadProjects();
        setView('dashboard');
      } finally {
        setLoading(false);
      }
    };

    return (
      <div className="max-w-2xl mx-auto">
        <button onClick={() => setView('dashboard')} className="text-blue-600 hover:text-blue-700 mb-6 flex items-center gap-2">← Back to Dashboard</button>
        <div className="bg-white rounded-lg border-2 border-gray-200 p-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">Create New Project</h2>
          <div className="space-y-5">
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Project Name</label><input type="text" value={formData.name} onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))} placeholder="my-awesome-project" className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Template</label><select value={formData.template} onChange={(e) => setFormData(prev => ({ ...prev, template: e.target.value }))} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"><option value="react">React + TypeScript</option><option value="vanilla">Vanilla JavaScript</option><option value="node">Node.js API</option><option value="php">PHP Backend</option><option value="python">Python Flask</option><option value="blank">Blank Project</option></select></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Deployment Target</label><select value={formData.target} onChange={(e) => setFormData(prev => ({ ...prev, target: e.target.value }))} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"><option value="server">Your Nginx Server</option><option value="github-pages">GitHub Pages</option><option value="both">Both</option></select></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Description (Optional)</label><textarea value={formData.description} onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))} placeholder="What does this project do?" rows={3} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
            <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-4"><h4 className="font-semibold text-blue-900 mb-2">What happens next:</h4><ul className="text-sm text-blue-800 space-y-1"><li>✓ GitHub repository will be created</li><li>✓ Starter files will be generated</li><li>✓ Webhook will be configured for auto-deployment</li><li>✓ Server directories will be set up</li></ul></div>
            <button onClick={handleCreate} disabled={loading || !formData.name} className="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium transition-colors">{loading ? 'Creating...' : 'Create Project'}</button>
          </div>
        </div>
      </div>
    );
  };

  const ImportProjectView = () => {
    const [formData, setFormData] = useState({
      repoUrl: '',
      branch: 'main',
      target: 'server',
      buildCommand: '',
      buildOutput: 'build',
      deployPath: '',
      installCommand: '',
      testCommand: '',
      startCommand: '',
      runtime: 'static',
      domain: '',
      port: ''
    });
    const [envText, setEnvText] = useState('');
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [importError, setImportError] = useState('');

    const handleImport = async () => {
      const normalizedRepoUrl = sanitizeGitHubRepoUrl(formData.repoUrl);
      if (!normalizedRepoUrl) {
        setImportError('Enter a valid public GitHub repository URL such as https://github.com/owner/repo');
        return;
      }
      setImportError('');
      setLoading(true);
      try {
        const env = envText.split('\n').map(line => line.trim()).filter(Boolean).reduce((acc, line) => {
          const [key, ...rest] = line.split('=');
          if (!key) return acc;
          acc[key.trim()] = rest.join('=').trim();
          return acc;
        }, {});
        const payload = { ...formData, repoUrl: normalizedRepoUrl, env };
        const res = await fetch(`${API_BASE}/projects/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          const detail = await describeHttpError(res);
          throw new Error(detail);
        }
        await loadProjects();
        setView('dashboard');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Import failed';
        setImportError(message || 'Import failed');
      } finally {
        setLoading(false);
      }
    };

    return (
      <div className="max-w-2xl mx-auto">
        <button onClick={() => setView('dashboard')} className="text-blue-600 hover:text-blue-700 mb-6 flex items-center gap-2">← Back to Dashboard</button>
        <div className="bg-white rounded-lg border-2 border-gray-200 p-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">Import Existing Project</h2>
          <div className="space-y-5">
            <div><label className="block text-sm font-medium text-gray-700 mb-2">GitHub Repository URL</label><input type="text" value={formData.repoUrl} onChange={(e) => setFormData(prev => ({ ...prev, repoUrl: e.target.value }))} placeholder="https://github.com/username/repo-name" className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
            <div className="grid md:grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium text-gray-700 mb-2">Branch</label><input type="text" value={formData.branch} onChange={(e) => setFormData(prev => ({ ...prev, branch: e.target.value }))} placeholder="main" className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
              <div><label className="block text-sm font-medium text-gray-700 mb-2">Deployment Target</label><select value={formData.target} onChange={(e) => setFormData(prev => ({ ...prev, target: e.target.value }))} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"><option value="server">Your Nginx Server</option><option value="github-pages">GitHub Pages</option><option value="both">Both</option></select></div>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium text-gray-700 mb-2">Build Command</label><input type="text" value={formData.buildCommand} onChange={(e) => setFormData(prev => ({ ...prev, buildCommand: e.target.value }))} placeholder="npm run build" className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
              <div><label className="block text-sm font-medium text-gray-700 mb-2">Build Output Directory</label><input type="text" value={formData.buildOutput} onChange={(e) => setFormData(prev => ({ ...prev, buildOutput: e.target.value }))} placeholder="build, dist, out..." className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
            </div>
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Deploy Path (Server)</label><input type="text" value={formData.deployPath} onChange={(e) => setFormData(prev => ({ ...prev, deployPath: e.target.value }))} placeholder="/var/www/project-name" className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
            <div className="grid md:grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium text-gray-700 mb-2">Runtime</label><select value={formData.runtime} onChange={(e) => setFormData(prev => ({ ...prev, runtime: e.target.value }))} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"><option value="static">Static / SPA</option><option value="node">Node.js App</option></select></div>
              <div><label className="block text-sm font-medium text-gray-700 mb-2">Custom Domain</label><input type="text" value={formData.domain} onChange={(e) => setFormData(prev => ({ ...prev, domain: e.target.value }))} placeholder="app.example.com" className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
            </div>
            <div><label className="block text-sm font-medium text-gray-700 mb-2">App Port (Node runtime)</label><input type="text" value={formData.port} onChange={(e) => setFormData(prev => ({ ...prev, port: e.target.value }))} placeholder="e.g. 4173" className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
            <button type="button" className="text-sm text-blue-600 font-medium" onClick={() => setShowAdvanced(prev => !prev)}>
              {showAdvanced ? 'Hide Advanced Options' : 'Show Advanced Options'}
            </button>
            {showAdvanced && (
              <div className="space-y-4 border-2 border-gray-200 rounded-lg p-4">
                <div className="grid md:grid-cols-2 gap-4">
                  <div><label className="block text-sm font-medium text-gray-700 mb-2">Install Command</label><input type="text" value={formData.installCommand} onChange={(e) => setFormData(prev => ({ ...prev, installCommand: e.target.value }))} placeholder="npm ci" className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                  <div><label className="block text-sm font-medium text-gray-700 mb-2">Test Command</label><input type="text" value={formData.testCommand} onChange={(e) => setFormData(prev => ({ ...prev, testCommand: e.target.value }))} placeholder="npm test" className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                </div>
                <div><label className="block text-sm font-medium text-gray-700 mb-2">Start Command (Node runtime)</label><input type="text" value={formData.startCommand} onChange={(e) => setFormData(prev => ({ ...prev, startCommand: e.target.value }))} placeholder="npm run start:prod" className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                <div><label className="block text-sm font-medium text-gray-700 mb-2">Environment Variables (KEY=VALUE per line)</label><textarea value={envText} onChange={(e) => setEnvText(e.target.value)} rows={4} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" placeholder="API_URL=https://api.example.com&#10;NODE_ENV=production" /></div>
              </div>
            )}
            <div className="bg-green-50 border-2 border-green-200 rounded-lg p-4"><h4 className="font-semibold text-green-900 mb-2">System will auto-detect:</h4><ul className="text-sm text-green-800 space-y-1"><li>✓ Tech stack (package.json, requirements.txt, composer.json)</li><li>✓ Build commands if not specified</li><li>✓ Optimal deployment configuration</li></ul></div>
            {importError && (
              <div className="rounded-lg border-2 border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {importError}
              </div>
            )}
            <button onClick={handleImport} disabled={loading || !formData.repoUrl} className="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium transition-colors">{loading ? 'Importing...' : 'Import & Setup'}</button>
          </div>
        </div>
      </div>
    );
  };

  const LogsView = () => {
    const deployments = deploymentHistory[selectedProject?.id] || [];
    const activeStatus = deploymentStatus[selectedProject?.id];
    const isDeploying = selectedProject?.id ? deployingProjects.has(selectedProject.id) : false;
    return (
      <div className="max-w-4xl mx-auto">
        <button onClick={() => setView('dashboard')} className="text-blue-600 hover:text-blue-700 mb-6 flex items-center gap-2">← Back to Dashboard</button>
        <div className="bg-white rounded-lg border-2 border-gray-200 p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">{selectedProject?.name}</h2>
              <p className="text-gray-600">Branch {selectedProject?.branch} · {selectedProject?.repo}</p>
            </div>
            <div className="flex items-center gap-3">
              {activeStatus?.status && (
                <span className={`px-3 py-1 rounded-full text-sm border ${getStatusColor(activeStatus.status)}`}>{activeStatus.status}</span>
              )}
              <button
                onClick={() => handleDeploy(selectedProject?.id)}
                disabled={!selectedProject?.id || isDeploying}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                {isDeploying ? <><Clock className="w-4 h-4 animate-spin" />Deploying...</> : <><RotateCcw className="w-4 h-4" />Deploy</>}
              </button>
              <button
                onClick={() => handleRollback(selectedProject?.id)}
                disabled={!selectedProject?.id || rollbackLoading}
                className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-900 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                <Terminal className="w-4 h-4" />{rollbackLoading ? 'Rolling back...' : 'Rollback'}
              </button>
            </div>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold text-gray-900">Deployment History</h3>
              <button onClick={() => fetchProjectDeployments(selectedProject?.id)} className="text-sm text-blue-600 hover:text-blue-800">Refresh</button>
            </div>
            {deployments.length === 0 && (
              <p className="text-gray-500 text-sm">No deployments yet. Run your first deploy to see history and logs.</p>
            )}
            {deployments.length > 0 && (
              <div className="divide-y divide-gray-200">
                {deployments.map(deployment => (
                  <div key={deployment.deploymentId} className="flex flex-col md:flex-row md:items-center justify-between py-4 gap-3">
                    <div>
                      <p className="font-semibold text-gray-900">#{deployment.deploymentId.slice(0, 8)}</p>
                      <p className="text-sm text-gray-600">{new Date(deployment.createdAt).toLocaleString()}</p>
                      <p className="text-xs text-gray-500">{deployment.commit || 'Commit unavailable'}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`px-3 py-1 rounded-full text-sm border ${getStatusColor(deployment.status)}`}>{deployment.status}</span>
                      <button onClick={() => openLogs(deployment.deploymentId)} className="flex items-center gap-1 text-blue-600 hover:text-blue-800 text-sm font-medium">
                        <FileText className="w-4 h-4" />View Logs
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const SettingsView = () => {
    const [activeTab, setActiveTab] = useState('general');
    
    return (
      <div className="max-w-4xl mx-auto">
        <button onClick={() => setView('dashboard')} className="text-blue-600 hover:text-blue-700 mb-6 flex items-center gap-2">← Back to Dashboard</button>
        <div className="bg-white rounded-lg border-2 border-gray-200 overflow-hidden">
          <div className="border-b-2 border-gray-200 flex">
            <button onClick={() => setActiveTab('general')} className={`px-6 py-3 font-medium ${activeTab === 'general' ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}>General</button>
            <button onClick={() => setActiveTab('integrations')} className={`px-6 py-3 font-medium ${activeTab === 'integrations' ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}>Integrations</button>
            <button onClick={() => setActiveTab('advanced')} className={`px-6 py-3 font-medium ${activeTab === 'advanced' ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}>Advanced</button>
          </div>
          
          <div className="p-8">
            {activeTab === 'general' && (
              <>
                <h2 className="text-2xl font-bold text-gray-900 mb-6">{selectedProject?.name} Settings</h2>
                {!settingsForm && <p className="text-sm text-gray-500">Loading project details…</p>}
                {settingsForm && (
                  <div className="space-y-6">
                    {settingsAlert.message && (
                      <div className={`rounded-lg border px-4 py-2 text-sm ${settingsAlert.type === 'error' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-700'}`}>
                        {settingsAlert.message}
                      </div>
                    )}
                    <div>
                      <h3 className="font-semibold text-gray-900 mb-3">Project Info</h3>
                      <div className="space-y-3">
                        <div><label className="block text-sm font-medium text-gray-700 mb-1">Name</label><input type="text" value={settingsForm.name} onChange={(e) => updateSettingsField('name', e.target.value)} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                        <div><label className="block text-sm font-medium text-gray-700 mb-1">Description</label><textarea value={settingsForm.description} onChange={(e) => updateSettingsField('description', e.target.value)} rows={2} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                        <div><label className="block text-sm font-medium text-gray-700 mb-1">GitHub Repository URL</label><input type="text" value={settingsForm.repoUrl} onChange={(e) => updateSettingsField('repoUrl', e.target.value)} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                        <div><label className="block text-sm font-medium text-gray-700 mb-1">Branch</label><input type="text" value={settingsForm.branch} onChange={(e) => updateSettingsField('branch', e.target.value)} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                      </div>
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 mb-3">Build Configuration</h3>
                      <div className="space-y-3">
                        <div><label className="block text-sm font-medium text-gray-700 mb-1">Build Command</label><input type="text" value={settingsForm.buildCommand} onChange={(e) => updateSettingsField('buildCommand', e.target.value)} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                        <div><label className="block text-sm font-medium text-gray-700 mb-1">Output Directory</label><input type="text" value={settingsForm.buildOutput} onChange={(e) => updateSettingsField('buildOutput', e.target.value)} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                      </div>
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 mb-3">Deployment</h3>
                      <div className="space-y-3">
                        <div><label className="block text-sm font-medium text-gray-700 mb-1">Deploy Path</label><input type="text" value={settingsForm.deployPath} onChange={(e) => updateSettingsField('deployPath', e.target.value)} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                        <div className="grid md:grid-cols-2 gap-4">
                          <div><label className="block text-sm font-medium text-gray-700 mb-1">Target</label><select value={settingsForm.target} onChange={(e) => updateSettingsField('target', e.target.value)} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"><option value="server">Nginx Server</option><option value="github-pages">GitHub Pages</option><option value="both">Server + GitHub Pages</option></select></div>
                          <div><label className="block text-sm font-medium text-gray-700 mb-1">Runtime</label><select value={settingsForm.runtime} onChange={(e) => updateSettingsField('runtime', e.target.value)} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"><option value="static">Static / SPA</option><option value="node">Node.js App</option></select></div>
                        </div>
                        <div className="grid md:grid-cols-2 gap-4">
                          <div><label className="block text-sm font-medium text-gray-700 mb-1">Custom Domain</label><input type="text" value={settingsForm.domain} onChange={(e) => updateSettingsField('domain', e.target.value)} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                          <div><label className="block text-sm font-medium text-gray-700 mb-1">App Port (Node runtime)</label><input type="text" value={settingsForm.port} onChange={(e) => updateSettingsField('port', e.target.value.replace(/[^0-9]/g, ''))} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-3 pt-4 border-t-2 border-gray-200">
                      <button onClick={saveProjectSettings} disabled={settingsSaving} className="flex-1 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:bg-gray-400 disabled:cursor-not-allowed">{settingsSaving ? 'Saving…' : 'Save Changes'}</button>
                      <button
                        onClick={() => handleDeleteProject(selectedProject?.id)}
                        disabled={!selectedProject?.id}
                        className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium flex items-center gap-2 disabled:bg-gray-400 disabled:cursor-not-allowed"
                      >
                        <Trash2 className="w-4 h-4" />Delete Project
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
            
            {activeTab === 'integrations' && (
              <>
                <h2 className="text-2xl font-bold text-gray-900 mb-2">Integrations</h2>
                <p className="text-gray-600 mb-6">Connect your project with external services</p>
                <div className="space-y-4">
                  <div className="border-2 border-gray-200 rounded-lg p-4"><div className="flex items-center justify-between mb-2"><div className="flex items-center gap-3"><div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center"><span className="text-purple-600 font-bold">S</span></div><div><h4 className="font-semibold text-gray-900">Slack</h4><p className="text-sm text-gray-600">Deployment notifications</p></div></div><label className="relative inline-flex items-center cursor-pointer"><input type="checkbox" className="sr-only peer" /><div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div></label></div><input type="text" placeholder="Webhook URL" className="w-full mt-2 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                  <div className="border-2 border-gray-200 rounded-lg p-4"><div className="flex items-center justify-between mb-2"><div className="flex items-center gap-3"><div className="w-10 h-10 bg-orange-100 rounded-lg flex items-center justify-center"><span className="text-orange-600 font-bold">S3</span></div><div><h4 className="font-semibold text-gray-900">AWS S3</h4><p className="text-sm text-gray-600">Deploy to S3 bucket</p></div></div><label className="relative inline-flex items-center cursor-pointer"><input type="checkbox" className="sr-only peer" /><div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div></label></div><div className="mt-2 space-y-2"><input type="text" placeholder="Bucket Name" className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /><input type="text" placeholder="Region (e.g., us-east-1)" className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div></div>
                  <div className="border-2 border-gray-200 rounded-lg p-4"><div className="flex items-center justify-between mb-2"><div className="flex items-center gap-3"><div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center"><span className="text-blue-600 font-bold">🐳</span></div><div><h4 className="font-semibold text-gray-900">Docker</h4><p className="text-sm text-gray-600">Container deployment</p></div></div><label className="relative inline-flex items-center cursor-pointer"><input type="checkbox" className="sr-only peer" /><div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div></label></div><div className="mt-2 space-y-2"><input type="text" placeholder="Image Name" className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /><input type="number" placeholder="Port (e.g., 3000)" className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div></div>
                </div>
                <button className="w-full mt-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium">Save Integration Settings</button>
              </>
            )}
            
            {activeTab === 'advanced' && (
              <>
                <h2 className="text-2xl font-bold text-gray-900 mb-6">Advanced Settings</h2>
                {!settingsForm && <p className="text-sm text-gray-500">Loading configuration…</p>}
                {settingsForm && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="font-semibold text-gray-900 mb-3">Runtime & Commands</h3>
                      <div className="grid md:grid-cols-3 gap-4">
                        <div><label className="block text-sm font-medium text-gray-700 mb-1">Install Command</label><input type="text" value={settingsForm.installCommand} onChange={(e) => updateSettingsField('installCommand', e.target.value)} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                        <div><label className="block text-sm font-medium text-gray-700 mb-1">Test Command</label><input type="text" value={settingsForm.testCommand} onChange={(e) => updateSettingsField('testCommand', e.target.value)} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                        <div><label className="block text-sm font-medium text-gray-700 mb-1">Start Command (Node)</label><input type="text" value={settingsForm.startCommand} onChange={(e) => updateSettingsField('startCommand', e.target.value)} className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none" /></div>
                      </div>
                      <button onClick={saveProjectSettings} disabled={settingsSaving} className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:bg-gray-400 disabled:cursor-not-allowed">{settingsSaving ? 'Saving…' : 'Save Runtime & Commands'}</button>
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 mb-3">Environment Variables</h3>
                      {envAlert.message && (
                        <div className={`rounded-lg border px-4 py-2 text-sm mb-3 ${envAlert.type === 'error' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-700'}`}>
                          {envAlert.message}
                        </div>
                      )}
                      <div className="space-y-3">
                        {envEntries.length === 0 && (
                          <p className="text-sm text-gray-500">No environment variables configured.</p>
                        )}
                        {envEntries.map((entry, index) => (
                          <div key={entry.id || `${index}-${entry.key}`} className="border border-gray-200 rounded-lg p-3 space-y-2">
                            <div className="grid md:grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-medium text-gray-700 mb-1">Key</label>
                                <input
                                  type="text"
                                  value={entry.key}
                                  onChange={(e) => updateEnvEntry(index, 'key', e.target.value)}
                                  placeholder="KEY"
                                  className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-gray-700 mb-1">{entry.isSecret ? 'Secret Value' : 'Value'}</label>
                                {entry.isSecret ? (
                                  <>
                                    <input
                                      type="password"
                                      value={entry.value}
                                      onChange={(e) => updateEnvEntry(index, 'value', e.target.value)}
                                      placeholder={entry.hasValue ? 'Enter new secret value to replace existing' : 'Enter secret value'}
                                      className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"
                                    />
                                    {entry.hasValue && !entry.value && (
                                      <p className="text-xs text-gray-500 mt-1">Secret is set. Provide a new value to update.</p>
                                    )}
                                  </>
                                ) : (
                                  <input
                                    type="text"
                                    value={entry.value}
                                    onChange={(e) => updateEnvEntry(index, 'value', e.target.value)}
                                    placeholder="Value"
                                    className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"
                                  />
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between">
                              <label className="flex items-center gap-2 text-sm text-gray-700">
                                <input
                                  type="checkbox"
                                  checked={entry.isSecret}
                                  onChange={(e) => toggleSecretFlag(index, e.target.checked)}
                                  disabled={entry.isSecret && entry.hasValue}
                                />
                                <span>{entry.isSecret ? 'Secret' : 'Plain'}</span>
                              </label>
                              <button type="button" onClick={() => removeEnvEntry(index)} className="text-sm text-red-600 hover:text-red-800">Remove</button>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center gap-3 mt-4">
                        <button type="button" onClick={addEnvEntry} className="px-3 py-2 bg-gray-100 rounded-lg text-sm text-gray-700 hover:bg-gray-200">Add Variable</button>
                        <button type="button" onClick={saveEnvironment} disabled={envSaving} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm disabled:bg-gray-400 disabled:cursor-not-allowed">{envSaving ? 'Saving…' : 'Save Environment'}</button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-8">
        <div className="max-w-7xl mx-auto">
          <header className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3"><Server className="w-8 h-8 text-blue-600" />Deployment Dashboard</h1>
            <p className="text-gray-600 mt-1">Automated deployment system for your projects</p>
          </header>
          {view === 'dashboard' && <DashboardView />}
          {view === 'create' && <CreateProjectView />}
          {view === 'import' && <ImportProjectView />}
          {view === 'logs' && <LogsView />}
          {view === 'settings' && <SettingsView />}
        </div>
      </div>
      {logViewer.open && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Deployment Logs</h3>
                <p className="text-xs text-gray-500">#{logViewer.deploymentId?.slice(0, 8)}</p>
              </div>
              <button onClick={closeLogViewer} className="text-sm text-gray-600 hover:text-gray-900">Close</button>
            </div>
            <div className="bg-gray-900 text-green-100 text-sm font-mono p-4 overflow-auto flex-1">
              {logViewer.loading && <p>Loading logs...</p>}
              {!logViewer.loading && logViewer.error && <p className="text-red-400">{logViewer.error}</p>}
              {!logViewer.loading && !logViewer.error && (
                <pre className="whitespace-pre-wrap">{logViewer.content || 'No logs available yet.'}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default DeploymentDashboard;
