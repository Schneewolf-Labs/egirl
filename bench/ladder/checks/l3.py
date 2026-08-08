import sys; sys.path.insert(0, '.')
from inventory.report import total_value
from inventory import Store, Item
s = Store(); s.add(Item('A', 'a', 2, 3.0))
assert total_value(s) == 6.0, 'report.total_value wrong'
assert s.total_value() == 6.0, 'Store.total_value wrapper broken'
print('ok')
