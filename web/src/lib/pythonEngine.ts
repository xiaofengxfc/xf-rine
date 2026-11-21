import { registerPlugin } from '@capacitor/core';

interface PythonEnginePlugin {
  start(options: { token: string }): Promise<{ port: number }>;
}

export const PythonEngine = registerPlugin<PythonEnginePlugin>('PythonEngine');
