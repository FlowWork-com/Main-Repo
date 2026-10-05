import React from 'react';

// Status styling maps matching /AGENTS.md guidelines
const STATUS_CONFIG = {
  'Planning': { color: 'bg-blue-500', text: 'text-blue-500', icon: '📋' },
  'Running': { color: 'bg-amber-500', text: 'text-amber-500', icon: '⚙️' },
  'Waiting for approval': { color: 'bg-purple-500', text: 'text-purple-500', icon: '⏳' },
  'Verifying': { color: 'bg-teal-500', text: 'text-teal-500', icon: '🔍' },
  'Completed': { color: 'bg-green-500', text: 'text-green-500', icon: '✅' },
  'Failed': { color: 'bg-red-500', text: 'text-red-500', icon: '❌' }
};

export const TaskTimeline = ({ currentStep, stepsHistory = [] }) => {
  return (
    <div className="p-6 bg-slate-900 text-white rounded-xl max-w-md mx-auto border border-slate-800">
      <h3 className="text-lg font-bold mb-4 tracking-wide text-slate-300">Operational Progress</h3>
      <div className="relative border-l-2 border-slate-700 ml-4 space-y-6">
        {Object.keys(STATUS_CONFIG).map((step) => {
          const isActive = currentStep === step;
          const config = STATUS_CONFIG[step];
          
          return (
            <div key={step} className="relative pl-6 transition-all duration-300">
              {/* Timeline Node Dot */}
              <span className={`absolute -left-[9px] top-1 flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-slate-900 ${isActive ? config.color : 'bg-slate-700'}`}>
                {isActive && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-inherit opacity-75"></span>}
              </span>
              
              {/* Step Info Box */}
              <div className={`flex items-center gap-2 ${isActive ? 'opacity-100 font-semibold' : 'opacity-40 font-normal'}`}>
                <span>{config.icon}</span>
                <span className={isActive ? config.text : 'text-slate-400'}>{step}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
