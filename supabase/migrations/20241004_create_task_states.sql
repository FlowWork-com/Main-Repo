-- Create task_states table with step enum
-- This migration creates the task_states table to track workflow task progress
-- Following AGENTS.md principles: RLS enabled, no secrets exposed

-- Create step enum type
CREATE TYPE task_step AS ENUM (
  'Planning',
  'Running',
  'Waiting for approval',
  'Verifying',
  'Completed',
  'Failed'
);

-- Create task_states table
CREATE TABLE task_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL,
  step task_step NOT NULL DEFAULT 'Planning',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Ensure one active state per task
  CONSTRAINT unique_active_task_state UNIQUE (task_id) WHERE (step IN ('Planning', 'Running', 'Waiting for approval', 'Verifying'))
);

-- Create indexes for performance
CREATE INDEX idx_task_states_task_id ON task_states(task_id);
CREATE INDEX idx_task_states_step ON task_states(step);
CREATE INDEX idx_task_states_created_at ON task_states(created_at);

-- Enable Row-Level Security
ALTER TABLE task_states ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Note: Add specific policies based on your authentication/authorization model
-- These are placeholder policies - adjust based on your actual auth requirements

-- Example: Allow service role full access (for backend operations)
CREATE POLICY "Service role full access" ON task_states
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Example: Allow authenticated users to read their own task states
-- Adjust this policy based on your actual user/task relationship
CREATE POLICY "Authenticated read access" ON task_states
  FOR SELECT
  TO authenticated
  USING (true);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_task_states_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
CREATE TRIGGER task_states_updated_at
  BEFORE UPDATE ON task_states
  FOR EACH ROW
  EXECUTE FUNCTION update_task_states_updated_at();
