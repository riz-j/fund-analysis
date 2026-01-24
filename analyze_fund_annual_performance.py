import sqlite3
import pandas as pd
import argparse
import sys

def calculate_fund_performance(db_path, fund_name, year):
    conn = sqlite3.connect(db_path)
    
    query = """
    SELECT quarter, stock_ticker, portfolio_percentage, quarter_performance
    FROM positions 
    WHERE fund_name = ? AND year = ?
    """
    
    df = pd.read_sql_query(query, conn, params=(fund_name, year))
    conn.close()
    
    if df.empty:
        print(f"No data found for {fund_name} in {year}")
        return

    quarters = ['q1', 'q2', 'q3', 'q4']
    quarterly_returns = []
    
    print(f"Analysis for {fund_name} ({year})\n")
    print(f"{'Quarter':<10} | {'Known Weight %':<15} | {'Quarter Return %':<20}")
    print("-" * 55)

    for q in quarters:
        q_data = df[df['quarter'] == q].copy()
        
        if q_data.empty:
            print(f"{q:<10} | {'N/A':<15} | {'N/A':<20}")
            continue

        # Filter out rows with missing performance data
        valid_data = q_data.dropna(subset=['quarter_performance']).copy()
        
        total_weight = q_data['portfolio_percentage'].sum()
        known_weight = valid_data['portfolio_percentage'].sum()
        
        # Calculate contribution of known positions
        # Standard contribution: weight * return
        # But we need to normalize if we assume missing stocks behave like the partial portfolio
        # OR we just accept 0 return for missing ones. 
        # Given "manager-weighted performance", usually we want the portfolio's actual return. 
        # If we don't know the return of 20% of the portfolio, re-normalizing implies 
        # the manager's skill on the 80% applies to the 20%. This is a standard proxy.
        
        if known_weight == 0:
             q_return = 0.0
        else:
            # Re-normalize weights to sum to 100%
            valid_data['normalized_weight'] = valid_data['portfolio_percentage'] / known_weight
            q_return = (valid_data['normalized_weight'] * valid_data['quarter_performance']).sum()

        quarterly_returns.append(q_return)
        
        print(f"{q:<10} | {known_weight:<15.2f} | {q_return:<20.2f}")

    # Annual Link
    annual_return = 1.0
    for qr in quarterly_returns:
        annual_return *= (1 + qr / 100)
    
    annual_return_pct = (annual_return - 1) * 100
    
    print("-" * 55)
    print(f"Annual Aggregate Performance: {annual_return_pct:.2f}%")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Analyze fund performance from database')
    parser.add_argument('fund_name', help='Name of the fund')
    parser.add_argument('year', type=int, help='Year to analyze')
    parser.add_argument('--db', default='funds.db', help='Path to database file')

    args = parser.parse_args()
    
    calculate_fund_performance(args.db, args.fund_name, args.year)
