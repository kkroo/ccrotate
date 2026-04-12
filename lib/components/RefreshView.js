import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

const RefreshView = ({ accounts, onTestAccount, onComplete }) => {
  const [accountStates, setAccountStates] = useState(() =>
    accounts.map(account => ({
      email: account.email,
      status: 'pending',
      result: '...',
      serviceTier: null,
      credentialsUpdated: false
    }))
  );

  useEffect(() => {
    const runTests = async () => {
      const finalResults = [];

      // Process accounts sequentially (synchronously)
      for (const account of accounts) {
        // Update status to testing
        setAccountStates(prev => prev.map(state =>
          state.email === account.email
            ? { ...state, status: 'testing' }
            : state
        ));

        try {
          const result = await onTestAccount(account.email);
          const entry = {
            email: account.email,
            status: result.status,
            result: result.response.substring(0, 150),
            serviceTier: result.serviceTier || null,
            rateLimits: result.rateLimits || null,
            credentialsUpdated: result.credentialsUpdated || false
          };
          finalResults.push(entry);

          // Update with final result
          setAccountStates(prev => prev.map(state =>
            state.email === account.email ? { ...state, ...entry } : state
          ));
        } catch (error) {
          const entry = {
            email: account.email,
            status: 'error',
            result: error.message.substring(0, 150),
            serviceTier: null,
            credentialsUpdated: false
          };
          finalResults.push(entry);

          setAccountStates(prev => prev.map(state =>
            state.email === account.email ? { ...state, ...entry } : state
          ));
        }
      }

      onComplete(finalResults);
    };

    runTests();
  }, [accounts, onTestAccount, onComplete]);

  const getStatusDisplay = (status, credentialsUpdated) => {
    let baseDisplay;
    switch (status) {
      case 'pending':
        baseDisplay = { text: '⏳ Pending', color: 'gray' };
        break;
      case 'testing':
        baseDisplay = { text: '🔄 Testing', color: 'yellow' };
        break;
      case 'success':
        baseDisplay = { text: '✅ Active', color: 'green' };
        break;
      case 'error':
        baseDisplay = { text: '❌ Failed', color: 'red' };
        break;
      default:
        baseDisplay = { text: '❓ Unknown', color: 'gray' };
    }

    if (credentialsUpdated && (status === 'success' || status === 'error')) {
      baseDisplay.text += ' 🔄';
    }

    return baseDisplay;
  };

  const getTierDisplay = (serviceTier, rateLimits) => {
    if (!serviceTier) return { text: '-', color: 'gray' };
    const util = rateLimits?.utilization7d;
    const pct = util != null ? ` ${Math.round(util * 100)}%` : '';
    if (serviceTier === 'standard') return { text: `✅ std${pct}`, color: 'green' };
    return { text: `⚠️  ${serviceTier}${pct}`, color: 'yellow' };
  };

  return React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
    React.createElement(Text, { bold: true, color: 'blue' }, '🔄 Testing accounts and refreshing tokens...'),
    React.createElement(Text, null, ' '),
    
    // Header
    React.createElement(Box, null,
      React.createElement(Box, { width: '3%' },
        React.createElement(Text, { bold: true, color: 'gray' }, '#')
      ),
      React.createElement(Box, { width: '3%' },
        React.createElement(Text, { bold: true, color: 'gray' }, ' ')
      ),
      React.createElement(Box, { width: '28%' },
        React.createElement(Text, { bold: true, color: 'gray' }, 'Email')
      ),
      React.createElement(Box, { width: '13%' },
        React.createElement(Text, { bold: true, color: 'gray' }, 'Status')
      ),
      React.createElement(Box, { width: '18%' },
        React.createElement(Text, { bold: true, color: 'gray' }, 'Tier')
      ),
      React.createElement(Box, { width: '35%' },
        React.createElement(Text, { bold: true, color: 'gray' }, 'Result')
      )
    ),
    
    // Separator
    React.createElement(Box, null,
      React.createElement(Text, { color: 'gray' }, '─'.repeat(80))
    ),
    
    // Account rows
    ...accountStates.map((accountState, index) => {
      const statusDisplay = getStatusDisplay(accountState.status, accountState.credentialsUpdated);
      const tierDisplay = getTierDisplay(accountState.serviceTier, accountState.rateLimits);

      return React.createElement(Box, { key: accountState.email },
        React.createElement(Box, { width: '3%' },
          React.createElement(Text, { color: 'gray' }, index + 1)
        ),
        React.createElement(Box, { width: '3%' },
          React.createElement(Text, { color: 'gray' }, ' ')
        ),
        React.createElement(Box, { width: '28%' },
          React.createElement(Text, { color: 'white' }, accountState.email)
        ),
        React.createElement(Box, { width: '13%' },
          React.createElement(Text, { color: statusDisplay.color }, statusDisplay.text)
        ),
        React.createElement(Box, { width: '18%' },
          React.createElement(Text, { color: tierDisplay.color }, tierDisplay.text)
        ),
        React.createElement(Box, { width: '35%' },
          React.createElement(Text, { color: 'gray' },
            accountState.result + (accountState.credentialsUpdated ? ' (Updated)' : '')
          )
        )
      );
    }),
    
    React.createElement(Text, null, ' ')
  );
};

export default RefreshView;