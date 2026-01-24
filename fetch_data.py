import json
import sqlite3
import requests
import xml.etree.ElementTree as ET
import yfinance as yf
from datetime import datetime, timedelta
import time
import sys

# Constants
DB_FILE = 'funds.db'
SCHEMA_FILE = 'schema.sql'
FILINGS_FILE = 'filings.json'
USER_AGENT_SEC = "FundAnalysisTool/1.0 (contact@example.com)"
USER_AGENT_YAHOO = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"

# Caching
cusip_cache = {}

def init_db():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    with open(SCHEMA_FILE, 'r') as f:
        cursor.executescript(f.read())
    conn.commit()
    return conn

def get_ticker_from_cusip(cusip):
    if cusip in cusip_cache:
        return cusip_cache[cusip]
    
    url = f"https://query2.finance.yahoo.com/v1/finance/search?q={cusip}"
    headers = {'User-Agent': USER_AGENT_YAHOO}
    
    try:
        # Rate limit kindness
        time.sleep(0.5)
        response = requests.get(url, headers=headers)
        if response.status_code == 200:
            data = response.json()
            if 'quotes' in data and len(data['quotes']) > 0:
                ticker = data['quotes'][0]['symbol']
                # Clean ticker (replace '.' with '-' for yfinance if needed, though yf handles dots often? usually BRK.B -> BRK-B)
                ticker = ticker.replace('.', '-')
                cusip_cache[cusip] = ticker
                return ticker
    except Exception as e:
        print(f"Error fetching ticker for CUSIP {cusip}: {e}")
    
    return None

def get_quarter_dates(year, quarter):
    y = int(year)
    if quarter == 'q1':
        return f"{y}-01-01", f"{y}-03-31"
    elif quarter == 'q2':
        return f"{y}-04-01", f"{y}-06-30"
    elif quarter == 'q3':
        return f"{y}-07-01", f"{y}-09-30"
    elif quarter == 'q4':
        return f"{y}-10-01", f"{y}-12-31"
    return None, None

def get_performance(ticker, start_date, end_date):
    try:
        # Add a few days buffer to start/end to ensure we capture trading days
        # yfinance end date is exclusive, so add 1 day to end_date
        end_dt = datetime.strptime(end_date, "%Y-%m-%d")
        query_end = (end_dt + timedelta(days=5)).strftime("%Y-%m-%d") 
        
        # We need data covering the start to end.
        data = yf.download(ticker, start=start_date, end=query_end, progress=False)
        
        if data.empty:
            return None
            
        # Filter to strictly within the quarter
        mask = (data.index >= start_date) & (data.index <= end_date)
        quarter_data = data.loc[mask]
        
        if quarter_data.empty:
            return None
            
        # Get first available Open/Close and last available Close
        start_price = quarter_data.iloc[0]['Open']
        if hasattr(start_price, 'item'): start_price = start_price.item() # Handle Series/scalar
            
        end_price = quarter_data.iloc[-1]['Close']
        if hasattr(end_price, 'item'): end_price = end_price.item()
        
        if start_price == 0: return 0.0
        
        perf = ((end_price - start_price) / start_price) * 100
        return round(perf, 2)
        
    except Exception as e:
        print(f"Error calculating performance for {ticker}: {e}")
        return None

def process_filing(conn, fund_name, year, quarter, url):
    print(f"Processing {fund_name} {year} {quarter}...")
    
    # Fetch XML
    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT_SEC})
        if r.status_code != 200:
            print(f"Failed to fetch {url}: {r.status_code}")
            return
        xml_content = r.content
    except Exception as e:
        print(f"Error requesting {url}: {e}")
        return

    # Parse XML
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError as e:
        print(f"XML Parse Error: {e}")
        return

    # Parse XML
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError as e:
        print(f"XML Parse Error: {e}")
        return

    positions = []
    total_value = 0.0

    # Parse rows by iterating root children and checking tag name ignoring namespace
    for info in root:
        # Check if tag is infoTable (ignoring namespace)
        tag_local = info.tag.split('}')[-1] if '}' in info.tag else info.tag
        if 'infoTable' not in tag_local and 'InfoTable' not in tag_local:
            continue

        try:
            name_of_issuer = "Unknown"
            cusip = None
            val = 0.0
            shares = 0
            
            # Iterate children of infoTable
            for child in info:
                child_tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                
                if child_tag == 'nameOfIssuer':
                    name_of_issuer = child.text if child.text else "Unknown"
                elif child_tag == 'cusip':
                    cusip = child.text
                elif child_tag == 'value':
                    val = float(child.text) if child.text else 0.0
                elif child_tag == 'shrsOrPrnAmt':
                    # Handle nested shares
                    for sub in child:
                        sub_tag = sub.tag.split('}')[-1] if '}' in sub.tag else sub.tag
                        if sub_tag == 'sshPrnamt':
                            shares = int(sub.text) if sub.text else 0
                elif child_tag == 'sshPrnamt':
                    # Handle flat shares (rare but possible mapping difference)
                    shares = int(child.text) if child.text else 0

            if cusip:
                positions.append({
                    'cusip': cusip,
                    'name': name_of_issuer,
                    'value': val,
                    'shares': shares
                })
                total_value += val
        except Exception as e:
            print(f"Error parsing row: {e}")
            continue
            
    # Process positions
    start_date, end_date = get_quarter_dates(year, quarter)
    
    for pos in positions:
        ticker = get_ticker_from_cusip(pos['cusip'])
        if not ticker:
            print(f"Warning: No ticker found for CUSIP {pos['cusip']} ({pos['name']})")
            ticker = "UNKNOWN-" + pos['cusip'] # Fallback
            perf = None
        else:
            perf = get_performance(ticker, start_date, end_date)
            
        pct_portfolio = (pos['value'] / total_value * 100) if total_value > 0 else 0
        
        reported_price = (pos['value'] / pos['shares']) if pos['shares'] > 0 else 0.0
        
        # Insert into DB
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO positions 
            (year, quarter, fund_name, stock_ticker, shares_owned, portfolio_percentage, quarter_performance, reported_price)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (int(year), quarter, fund_name, ticker, pos['shares'], round(pct_portfolio, 4), perf, round(reported_price, 2)))
    
    conn.commit()

def main():
    conn = init_db()
    
    with open(FILINGS_FILE, 'r') as f:
        data = json.load(f)
        
    for fund_slug, years in data.items():
        fund_name = fund_slug.replace('-', ' ').title()
        for year, quarters in years.items():
            for q, url in quarters.items():
                process_filing(conn, fund_name, year, q, url)
                
    conn.close()
    print("Done!")

if __name__ == "__main__":
    main()
