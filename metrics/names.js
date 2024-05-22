module.exports = {
    ackSuccessRate: {
        type: 'meter',
        name: 'rabbit_message_ack_rate',
        samples: 1_000_000, // Keep in memory up to 1 million records for last 8 hours
        timeframe: 8 * 60 * 60 // keep track of last 8 hours
      },
      // Metrics used to work with messages
      consumeSuccessRate: {
        type: 'meter',
        name: 'rabbit_message_consume_rate',
        samples: 1_000_000, // Keep in memory up to 1 million records for last 8 hours
        timeframe: 8 * 60 * 60 // keep track of last 8 hours
      },
      // Metrics used to work with messages
      messageSuccessRate: {
        type: 'meter',
        name: 'rabbit_message_publish_rate',
        samples: 1_000_000, // Keep in memory up to 1 million records for last 8 hours
        timeframe: 8 * 60 * 60 // keep track of last 8 hours
      },
      reconnectedConnectionsCount: {
        type: 'counter',
        name: 'rabbit_reconnected_connections_count',
      },
      messageTotalCount: {
        type: 'counter',
        name: 'rabbit_message_total_count',
      },
      errorRate: {
        type: 'meter',
        name: 'rabbit_error_rate',
        samples: 1_000_000, // Keep in memory up to 1 million records for last 8 hours
        timeframe: 8 * 60 * 60 // keep track of last 8 hours
      }
}