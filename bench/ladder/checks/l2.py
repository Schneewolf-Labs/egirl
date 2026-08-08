import sys; sys.path.insert(0, '.')
from inventory import Store, Item
s = Store(); s.add(Item('A', 'a', 5, 1.0))
try:
    s.remove('A', 9)
    raise SystemExit('removing more than stock did not raise ValueError')
except ValueError:
    pass
s.remove('A', 5)
assert s.get('A') is None, 'item at zero qty was not removed from the store'
print('ok')
