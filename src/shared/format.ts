const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const count = new Intl.NumberFormat('en-IN')
const date = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

export const formatMoney = (paise: number): string => money.format(paise / 100)
export const formatCount = (value: number): string => count.format(value)
export const formatDate = (timestamp: string): string => date.format(new Date(timestamp))
