//! Example TWAP (Time-Weighted Average Price) Oracle Implementation
//! 
//! This is a reference implementation demonstrating manipulation-resistant
//! price oracle design for the ILN ecosystem.
//! 
//! Key Features:
//! 1. TWAP over configurable time windows (minimum 30 minutes recommended)
//! 2. Sliding window of price samples
//! 3. Protection against single-block manipulation
//! 4. Fallback mechanisms for data availability

#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, vec, Env, Address, Vec, Symbol};

#[contract]
pub struct TwapOracle;

/// Configuration for TWAP oracle
#[contracttype]
#[derive(Clone, Debug)]
pub struct OracleConfig {
    /// Minimum TWAP window in seconds (recommended: 1800 = 30 minutes)
    pub min_twap_window_seconds: u64,
    /// Maximum TWAP window in seconds
    pub max_twap_window_seconds: u64,
    /// Sample interval in seconds
    pub sample_interval_seconds: u64,
    /// Maximum number of samples to store
    pub max_samples: u32,
    /// Admin address who can update price samples
    pub admin: Address,
}

/// Price sample stored in oracle
#[contracttype]
#[derive(Clone, Debug)]
pub struct PriceSample {
    /// Timestamp when sample was taken
    pub timestamp: u64,
    /// Price in basis points (e.g., 20_000 = $20.00 per token unit)
    pub price_bps: i128,
    /// Token address this price is for
    pub token: Address,
}

/// Price data for a specific token
#[contracttype]
#[derive(Clone, Debug)]
pub struct TokenPriceData {
    /// Token address
    pub token: Address,
    /// Circular buffer of price samples
    pub samples: Vec<PriceSample>,
    /// Current index in circular buffer
    pub current_index: u32,
}

#[contractimpl]
impl TwapOracle {
    /// Initialize the TWAP oracle with configuration
    pub fn initialize(env: Env, config: OracleConfig) {
        // Validate configuration
        assert!(config.min_twap_window_seconds >= 1800, 
            "Minimum TWAP window must be at least 30 minutes (1800 seconds)");
        assert!(config.max_twap_window_seconds >= config.min_twap_window_seconds,
            "Max window must be >= min window");
        assert!(config.sample_interval_seconds > 0,
            "Sample interval must be positive");
        
        // Store configuration
        env.storage().instance().set(&Symbol::new(&env, "config"), &config);
    }
    
    /// Update price sample for a token (admin only)
    pub fn update_price(
        env: Env,
        token: Address,
        price_bps: i128,
        timestamp: u64,
    ) {
        // Verify caller is admin
        let config: OracleConfig = env.storage().instance()
            .get(&Symbol::new(&env, "config"))
            .unwrap();
        config.admin.require_auth();
        
        // Validate price is reasonable (optional, adjust as needed)
        assert!(price_bps > 0, "Price must be positive");
        assert!(price_bps <= 1_000_000_000, "Price unreasonably high"); // $10M per token unit max
        
        // Get or create token data
        let mut token_data: TokenPriceData = env.storage().persistent()
            .get(&Symbol::new(&env, "token_data"))
            .unwrap_or(TokenPriceData {
                token: token.clone(),
                samples: vec![&env],
                current_index: 0,
            });
        
        // Create new sample
        let new_sample = PriceSample {
            timestamp,
            price_bps,
            token: token.clone(),
        };
        
        let config: OracleConfig = env.storage().instance()
            .get(&Symbol::new(&env, "config"))
            .unwrap();
        
        // Add sample to circular buffer
        if token_data.samples.len() < config.max_samples as usize {
            // Buffer not full yet, append
            token_data.samples.push_back(new_sample);
        } else {
            // Buffer full, overwrite oldest sample
            let idx = token_data.current_index as usize;
            token_data.samples.set(idx, new_sample);
            token_data.current_index = (token_data.current_index + 1) % config.max_samples;
        }
        
        // Store updated token data
        env.storage().persistent()
            .set(&Symbol::new(&env, "token_data"), &token_data);
        
        // Emit event for off-chain monitoring
        env.events().publish(
            (Symbol::new(&env, "price_updated"), token),
            (timestamp, price_bps),
        );
    }
    
    /// Get TWAP price for token over specified window
    /// @param token: Token address
    /// @param window_seconds: TWAP window in seconds (must be between min and max config)
    /// @returns: Time-weighted average price in basis points
    pub fn get_price_twap(env: Env, token: Address, window_seconds: u64) -> i128 {
        // Validate window size
        let config: OracleConfig = env.storage().instance()
            .get(&Symbol::new(&env, "config"))
            .unwrap();
        
        assert!(window_seconds >= config.min_twap_window_seconds,
            format!("Window too small, minimum is {} seconds", config.min_twap_window_seconds));
        assert!(window_seconds <= config.max_twap_window_seconds,
            format!("Window too large, maximum is {} seconds", config.max_twap_window_seconds));
        
        // Get token data
        let token_data: TokenPriceData = match env.storage().persistent()
            .get(&Symbol::new(&env, "token_data")) {
            Some(data) => data,
            None => return 0, // No data available
        };
        
        assert!(token_data.token == token, "Token data mismatch");
        
        let current_time = env.ledger().timestamp();
        let window_start = current_time.saturating_sub(window_seconds);
        
        // Calculate TWAP
        let mut total_weighted_price: i128 = 0;
        let mut total_weight: u64 = 0;
        
        let samples = token_data.samples;
        let num_samples = samples.len();
        
        if num_samples == 0 {
            return 0; // No data
        }
        
        // Sort samples by timestamp (they should already be in order, but sort to be safe)
        let mut sorted_samples: Vec<PriceSample> = vec![&env];
        for i in 0..num_samples {
            sorted_samples.push_back(samples.get(i).unwrap());
        }
        // Note: In production, you'd want to sort by timestamp
        
        // Calculate TWAP using trapezoidal integration
        for i in 0..(num_samples - 1) {
            let sample1 = sorted_samples.get(i).unwrap();
            let sample2 = sorted_samples.get(i + 1).unwrap();
            
            // Skip if both samples are outside window
            if sample2.timestamp < window_start || sample1.timestamp > current_time {
                continue;
            }
            
            // Determine overlap with window
            let segment_start = sample1.timestamp.max(window_start);
            let segment_end = sample2.timestamp.min(current_time);
            
            if segment_end > segment_start {
                let segment_duration = segment_end - segment_start;
                let average_price = (sample1.price_bps + sample2.price_bps) / 2;
                
                total_weighted_price += average_price * (segment_duration as i128);
                total_weight += segment_duration;
            }
        }
        
        if total_weight > 0 {
            total_weighted_price / (total_weight as i128)
        } else {
            // Not enough data in window, fallback to latest price
            let latest_sample = sorted_samples.get(num_samples - 1).unwrap();
            latest_sample.price_bps
        }
    }
    
    /// Get price with default TWAP window (1 hour)
    pub fn get_price(env: Env, token: Address) -> i128 {
        self.get_price_twap(env, token, 3600) // Default 1-hour TWAP
    }
    
    /// Get available TWAP windows supported by this oracle
    pub fn get_supported_windows(env: Env) -> Vec<u64> {
        let config: OracleConfig = env.storage().instance()
            .get(&Symbol::new(&env, "config"))
            .unwrap();
        
        // Return common windows: 30min, 1h, 4h, 24h (if within config limits)
        let mut windows = vec![&env];
        let common_windows = vec![1800, 3600, 14400, 86400]; // 30min, 1h, 4h, 24h
        
        for window in common_windows {
            if window >= config.min_twap_window_seconds && 
               window <= config.max_twap_window_seconds {
                windows.push_back(window);
            }
        }
        
        windows
    }
    
    /// Get oracle health status
    pub fn get_health_status(env: Env, token: Address) -> (u64, u64, i128) {
        let token_data: TokenPriceData = match env.storage().persistent()
            .get(&Symbol::new(&env, "token_data")) {
            Some(data) => data,
            None => return (0, 0, 0),
        };
        
        let num_samples = token_data.samples.len() as u64;
        let current_time = env.ledger().timestamp();
        
        // Calculate data freshness
        let latest_timestamp = if num_samples > 0 {
            let latest_sample = token_data.samples.get(num_samples as usize - 1).unwrap();
            latest_sample.timestamp
        } else {
            0
        };
        
        let freshness_seconds = current_time.saturating_sub(latest_timestamp);
        
        // Calculate price volatility (simplified)
        let volatility = if num_samples >= 2 {
            let mut price_changes = vec![&env];
            for i in 1..num_samples {
                let prev = token_data.samples.get(i as usize - 1).unwrap().price_bps;
                let curr = token_data.samples.get(i as usize).unwrap().price_bps;
                let change = ((curr - prev).abs() * 100) / prev.abs().max(1);
                price_changes.push_back(change);
            }
            
            // Average change
            let mut sum = 0;
            for i in 0..price_changes.len() {
                sum += price_changes.get(i).unwrap();
            }
            sum / (price_changes.len() as i128)
        } else {
            0
        };
        
        (num_samples, freshness_seconds, volatility)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Ledger;
    
    #[test]
    fn test_twap_calculation() {
        let env = Env::default();
        env.mock_all_auths();
        
        // Initialize oracle
        let oracle = TwapOracleClient::new(&env, &env.register_contract(None, TwapOracle));
        let admin = Address::generate(&env);
        
        let config = OracleConfig {
            min_twap_window_seconds: 1800,
            max_twap_window_seconds: 86400,
            sample_interval_seconds: 300, // 5 minutes
            max_samples: 100,
            admin: admin.clone(),
        };
        
        oracle.initialize(&config);
        
        // Simulate price updates over time
        let token = Address::generate(&env);
        let mut ledger = env.ledger().get();
        
        // Update price at t=0: $20.00
        ledger.timestamp = 0;
        env.ledger().set(ledger.clone());
        oracle.update_price(&token, &20_000, &0);
        
        // Update price at t=1800: $21.00 (30 minutes later)
        ledger.timestamp = 1800;
        env.ledger().set(ledger.clone());
        oracle.update_price(&token, &21_000, &1800);
        
        // Get TWAP over 30-minute window at t=1800
        ledger.timestamp = 1800;
        env.ledger().set(ledger);
        let twap_price = oracle.get_price_twap(&token, &1800);
        
        // Should be average of $20.00 and $21.00 = $20,500
        assert_eq!(twap_price, 20_500);
    }
    
    #[test]
    fn test_window_validation() {
        let env = Env::default();
        env.mock_all_auths();
        
        let oracle = TwapOracleClient::new(&env, &env.register_contract(None, TwapOracle));
        let admin = Address::generate(&env);
        
        let config = OracleConfig {
            min_twap_window_seconds: 1800, // 30 minutes minimum
            max_twap_window_seconds: 86400, // 24 hours maximum
            sample_interval_seconds: 300,
            max_samples: 100,
            admin: admin.clone(),
        };
        
        oracle.initialize(&config);
        
        let token = Address::generate(&env);
        
        // Should fail: window too small (15 minutes < 30 minute minimum)
        let result = oracle.try_get_price_twap(&token, &900);
        assert!(result.is_err());
        
        // Should fail: window too large (25 hours > 24 hour maximum)
        let result = oracle.try_get_price_twap(&token, &(25 * 3600));
        assert!(result.is_err());
        
        // Should succeed: 1 hour window (within bounds)
        let result = oracle.try_get_price_twap(&token, &3600);
        assert!(result.is_ok());
    }
}