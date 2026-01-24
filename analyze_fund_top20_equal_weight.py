import sqlite3
import pandas as pd
import argparse
import sys

def calculate_top20_equal_weight_performance(db_path, fund_name, year):
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
    
    print(f"Analysis for {fund_name} ({year}) - Top 20 Holdings Equal-Weighted")
    print("-" * 75)
    print(f"{'Quarter':<10} | {'Stocks Used':<12} | {'Analyzed Weight %':<18} | {'Equal-Wt Return %':<20}")
    print("-" * 75)

    for q in quarters:
        q_data = df[df['quarter'] == q].copy()
        
        if q_data.empty:
            print(f"{q:<10} | {'0':<12} | {'N/A':<18} | {'N/A':<20}")
            continue

        # Filter out rows with missing performance data
        valid_data = q_data.dropna(subset=['quarter_performance']).copy()
        
        # Sort by portfolio_percentage descending and take top 20
        top_20 = valid_data.sort_values(by='portfolio_percentage', ascending=False).head(20)
        
        num_stocks = len(top_20)
        analyzed_weight = top_20['portfolio_percentage'].sum()
        
        if num_stocks == 0:
             print(f"{q:<10} | {num_stocks:<12} | {analyzed_weight:<18.2f} | {'N/A':<20}")
        else:
            # Calculate equal-weighted return (mean of quarter_performance)
            q_return = top_20['quarter_performance'].mean()
            
            quarterly_returns.append(q_return)
            print(f"{q:<10} | {num_stocks:<12} | {analyzed_weight:<18.2f} | {q_return:<20.2f}")

    # Annual Link
    annual_return = 1.0
    for qr in quarterly_returns:
        annual_return *= (1 + qr / 100)
    
    annual_return_pct = (annual_return - 1) * 100
    
    print("-" * 75)
    print(f"Annual Aggregate Performance (Top 20 Equal-Wt): {annual_return_pct:.2f}%")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Analyze fund performance (Top 20 Equal-Weighted) from database')
    parser.add_argument('fund_name', help='Name of the fund')
    parser.add_argument('year', type=int, help='Year to analyze')
    parser.add_argument('--db', default='funds.db', help='Path to database file')
    
    args = parser.parse_args()
    
    calculate_top20_equal_weight_performance(args.db, args.fund_name, args.year)
